import React, { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { lazyWithRetry } from '@/routing/lazyWithRetry';
import { createPortal } from 'react-dom';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Star, Film, Tv2, User, GitBranch, ZoomIn, ZoomOut, Maximize2, ArrowLeft, Network, Sparkles, Eye, Loader, HelpCircle, Settings2 } from 'lucide-react';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { forceCollide } from 'd3-force-3d';

// Heavy graph renderer (~140 KB minified) — code-split into its own chunk so
// the page shell loads before the graph engine is fetched.
const ForceGraph2D = lazy(() => lazyWithRetry(() => import('react-force-graph-2d')));
import {
  fetchContentGraph,
  fetchPersonGraph,
  searchTMDB,
  fetchTrending,
  NODE_COLORS,
  DEFAULT_GRAPH_OPTIONS,
  type GraphNode,
  type GraphLink,
  type GraphData,
  type GraphFetchOptions,
} from '../services/cineGraphService';
import { encodeId } from '../utils/idEncoder';
import { SquareBackground } from '../components/ui/square-background';
import '../styles/cinegraph.css';
import { getOverlayPortalRoot } from '@/utils/overlayPortal';

// ─── Image cache for canvas rendering ────────────────────────────────────────

const imageCache = new Map<string, HTMLImageElement>();

function loadImage(url: string): HTMLImageElement | null {
  if (imageCache.has(url)) return imageCache.get(url)!;
  const img = new Image();
  img.src = url;
  img.crossOrigin = 'anonymous';
  img.onload = () => imageCache.set(url, img);
  return null; // not ready yet
}

// ─── Legend items ─────────────────────────────────────────────────────────────

const LEGEND_ITEMS = [
  { type: 'movie', labelKey: 'cinegraph.films', color: NODE_COLORS.movie, icon: <Film size={12} /> },
  { type: 'tv', labelKey: 'cinegraph.series', color: NODE_COLORS.tv, icon: <Tv2 size={12} /> },
  { type: 'person', labelKey: 'cinegraph.persons', color: NODE_COLORS.person, icon: <User size={12} /> },
  { type: 'genre', labelKey: 'cinegraph.genresLabel', color: NODE_COLORS.genre, icon: <Sparkles size={12} /> },
] as const;

const LINK_LABELS: Record<string, string> = {
  actor: 'cinegraph.actor',
  director: 'cinegraph.director',
  genre: 'cinegraph.genre',
  similar: 'cinegraph.similar',
  recommendation: 'cinegraph.recommendation',
  company: 'cinegraph.company',
};

// ─── CinéGraph Page ──────────────────────────────────────────────────────────

const CineGraphPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation();

  // Graph data
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('');
  const [rootNode, setRootNode] = useState<{ id: number; type: 'movie' | 'tv' | 'person'; title: string } | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Trending for home
  const [trending, setTrending] = useState<any[]>([]);

  // Visual filters
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set(['movie', 'tv', 'person', 'genre']));

  // Tooltip
  const [tooltip, setTooltip] = useState<{ node: GraphNode; x: number; y: number } | null>(null);

  // Detail panel
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  // Graph ref
  const graphRef = useRef<ForceGraphMethods>();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Highlighted node
  const [highlightedNode, setHighlightedNode] = useState<string | null>(null);
  const [highlightedLinks, setHighlightedLinks] = useState<Set<string>>(new Set());

  // Help modal
  const [showHelp, setShowHelp] = useState(false);
  const [helpClosing, setHelpClosing] = useState(false);

  // Settings modal
  const [showSettings, setShowSettings] = useState(false);
  const [settingsClosing, setSettingsClosing] = useState(false);
  const [graphOptions, setGraphOptions] = useState<GraphFetchOptions>(() => {
    try {
      const saved = sessionStorage.getItem('cinegraph-options');
      if (saved) return { ...DEFAULT_GRAPH_OPTIONS, ...JSON.parse(saved) };
    } catch {}
    return { ...DEFAULT_GRAPH_OPTIONS };
  });

  // Persist options to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem('cinegraph-options', JSON.stringify(graphOptions));
    } catch {}
  }, [graphOptions]);

  // Disable body scroll when help modal is open
  useEffect(() => {
    if (!showHelp) return;
    const orig = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = orig; };
  }, [showHelp]);

  const closeHelp = useCallback(() => {
    setHelpClosing(true);
    setTimeout(() => {
      setShowHelp(false);
      setHelpClosing(false);
    }, 300);
  }, []);

  // Settings modal close
  useEffect(() => {
    if (!showSettings) return;
    const orig = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = orig; };
  }, [showSettings]);

  const closeSettings = useCallback(() => {
    setSettingsClosing(true);
    setTimeout(() => {
      setShowSettings(false);
      setSettingsClosing(false);
    }, 300);
  }, []);

  // ─── Resize handler ─────────────────────────────────────────────────────────

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setDimensions({ width: rect.width, height: Math.max(rect.height, window.innerHeight - 280) });
      } else {
        setDimensions({ width: window.innerWidth, height: window.innerHeight - 280 });
      }
    };
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, [graphData]);

  // ─── Load trending on mount ─────────────────────────────────────────────────

  useEffect(() => {
    fetchTrending().then(setTrending);
  }, []);

  // ─── Configure forces (spacing) ─────────────────────────────────────────────

  useEffect(() => {
    if (graphRef.current) {
      graphRef.current.d3Force('charge')?.strength(-180);
      graphRef.current.d3Force('link')?.distance(75);
      graphRef.current.d3Force(
        'collide',
        forceCollide((n: any) => (n.val || 12) / 2 + 6).strength(1).iterations(2),
      );
      graphRef.current.d3ReheatSimulation();
    }
  }, [graphData, dimensions]);


  // ─── Handle URL params ──────────────────────────────────────────────────────

  useEffect(() => {
    const type = searchParams.get('type') as 'movie' | 'tv' | 'person' | null;
    const id = searchParams.get('id');
    if (type && id) {
      loadGraph(type, parseInt(id, 10));
    }
  }, [searchParams.get('type'), searchParams.get('id')]);

  // ─── Click outside search ──────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ─── Escape key closes detail panel ────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedNode(null);
        setHighlightedNode(null);
        setHighlightedLinks(new Set());
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // ─── Load Graph ─────────────────────────────────────────────────────────────

  const loadGraph = useCallback(async (type: 'movie' | 'tv' | 'person', tmdbId: number, title?: string) => {
    setLoading(true);
    setSelectedNode(null);
    setTooltip(null);

    const phrases = [
      t('cinegraph.mappingCinematicUniverse'),
      t('cinegraph.discoveringCreativeNetwork'),
      t('cinegraph.mappingCinematicUniverse'),
      t('cinegraph.discoveringCreativeNetwork'),
      t('cinegraph.mappingCinematicUniverse'),
    ];
    let phraseIdx = 0;
    setLoadingText(phrases[0]);
    const interval = setInterval(() => {
      phraseIdx = (phraseIdx + 1) % phrases.length;
      setLoadingText(phrases[phraseIdx]);
    }, 2000);

    try {
      let data: GraphData;
      if (type === 'person') {
        data = await fetchPersonGraph(tmdbId, graphOptions);
      } else {
        data = await fetchContentGraph(type, tmdbId, graphOptions.depth, graphOptions);
      }

      setGraphData(data);
      setRootNode({ id: tmdbId, type, title: title || data.nodes[0]?.label || '' });

      // Update URL
      setSearchParams({ type, id: String(tmdbId) });

      // Zoom to fit after data loaded
      setTimeout(() => {
        graphRef.current?.zoomToFit(600, 60);
      }, 800);
    } catch (err) {
      console.error('Failed to load graph:', err);
    } finally {
      clearInterval(interval);
      setLoading(false);
    }
  }, [setSearchParams, graphOptions]);

  // ─── Search handler ─────────────────────────────────────────────────────────

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    if (query.length < 2) {
      setSearchResults([]);
      setShowResults(false);
      return;
    }

    setSearchLoading(true);
    setShowResults(true);

    searchTimeoutRef.current = setTimeout(async () => {
      const results = await searchTMDB(query);
      setSearchResults(results);
      setSearchLoading(false);
    }, 350);
  }, []);

  // ─── Select search result ──────────────────────────────────────────────────

  const handleSelectResult = useCallback((item: any) => {
    setSearchQuery('');
    setShowResults(false);
    setSearchResults([]);
    loadGraph(item.type, item.id, item.title);
  }, [loadGraph]);

  // ─── Select trending item ──────────────────────────────────────────────────

  const handleSelectTrending = useCallback((item: any) => {
    loadGraph(item.type, item.id, item.title);
  }, [loadGraph]);

  // ─── Filter graph data by active types ─────────────────────────────────────

  const filteredData = useMemo(() => {
    const nodeIds = new Set(
      graphData.nodes.filter((n) => activeTypes.has(n.type)).map((n) => n.id)
    );
    return {
      nodes: graphData.nodes.filter((n) => activeTypes.has(n.type)),
      links: graphData.links.filter(
        (l) => {
          const srcId = typeof l.source === 'string' ? l.source : (l.source as any).id;
          const tgtId = typeof l.target === 'string' ? l.target : (l.target as any).id;
          return nodeIds.has(srcId) && nodeIds.has(tgtId);
        }
      ),
    };
  }, [graphData, activeTypes]);

  // ─── Node hover highlighting ───────────────────────────────────────────────

  const handleNodeHover = useCallback((node: any) => {
    if (!node) {
      setHighlightedNode(null);
      setHighlightedLinks(new Set());
      setTooltip(null);
      document.body.style.cursor = 'default';
      return;
    }
    document.body.style.cursor = 'pointer';

    setHighlightedNode(node.id);
    const connectedLinks = new Set<string>();
    filteredData.links.forEach((l: any) => {
      const srcId = typeof l.source === 'string' ? l.source : l.source?.id;
      const tgtId = typeof l.target === 'string' ? l.target : l.target?.id;
      if (srcId === node.id || tgtId === node.id) {
        connectedLinks.add(`${srcId}-${tgtId}`);
      }
    });
    setHighlightedLinks(connectedLinks);
  }, [filteredData.links]);

  // ─── Node click ────────────────────────────────────────────────────────────

  const handleNodeClick = useCallback((node: any) => {
    setSelectedNode(node as GraphNode);
    setTooltip(null);
  }, []);

  // ─── Manual click fallback on the canvas ────────────────────────────────────
  // react-force-graph's built-in click detection can swallow clicks when the
  // pointer moves even slightly, or after zoom/pan gestures. We wire our own
  // click detector on the canvas that walks graph data to find the node under
  // the pointer.
  useEffect(() => {
    if (!graphData.nodes.length) return;
    const container = containerRef.current;
    if (!container) return;
    const canvas = container.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    const pickNode = (clientX: number, clientY: number): GraphNode | null => {
      const g = graphRef.current;
      if (!g) return null;
      const rect = canvas.getBoundingClientRect();
      const graphCoords = g.screen2GraphCoords(clientX - rect.left, clientY - rect.top);
      let best: GraphNode | null = null;
      let bestDist = Infinity;
      for (const n of graphData.nodes as any[]) {
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        const dx = n.x - graphCoords.x;
        const dy = n.y - graphCoords.y;
        const d = Math.hypot(dx, dy);
        const size = n.val || 12;
        const hasImg = n.img && (n.type === 'movie' || n.type === 'tv' || n.type === 'person');
        const radius = hasImg ? size / 2 + 2 : size / 2 + 1;
        const hit = Math.max(radius, 12);
        if (d <= hit && d < bestDist) {
          best = n;
          bestDist = d;
        }
      }
      return best;
    };

    let downX = 0;
    let downY = 0;
    let lastHoverId: string | null = null;
    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
      const hit = pickNode(e.clientX, e.clientY);
      if (hit) handleNodeClick(hit);
    };
    const onMove = (e: PointerEvent) => {
      const hit = pickNode(e.clientX, e.clientY);
      const id = hit ? (hit as GraphNode).id : null;
      if (id === lastHoverId) return;
      lastHoverId = id;
      handleNodeHover(hit);
    };
    const onLeave = () => {
      if (lastHoverId === null) return;
      lastHoverId = null;
      handleNodeHover(null);
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [graphData, handleNodeClick, handleNodeHover]);

  // ─── Double-click to explore deeper ────────────────────────────────────────

  const handleNodeDblClick = useCallback((node: any) => {
    const gNode = node as GraphNode;
    if (gNode.type === 'movie' || gNode.type === 'tv' || gNode.type === 'person') {
      loadGraph(gNode.type, gNode.tmdbId, gNode.label);
    }
  }, [loadGraph]);

  // ─── Toggle legend filter ──────────────────────────────────────────────────

  const toggleType = useCallback((type: string) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        if (next.size > 1) next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  // ─── Connections for detail panel ──────────────────────────────────────────

  const getNodeConnections = useCallback((nodeId: string) => {
    return graphData.links
      .map((l: any) => {
        const srcId = typeof l.source === 'string' ? l.source : l.source?.id;
        const tgtId = typeof l.target === 'string' ? l.target : l.target?.id;
        if (srcId === nodeId) {
          const target = graphData.nodes.find((n) => n.id === tgtId);
          return target ? { node: target, link: l } : null;
        }
        if (tgtId === nodeId) {
          const source = graphData.nodes.find((n) => n.id === srcId);
          return source ? { node: source, link: l } : null;
        }
        return null;
      })
      .filter(Boolean) as { node: GraphNode; link: GraphLink }[];
  }, [graphData]);

  // ─── Custom node renderer ─────────────────────────────────────────────────

  const paintNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
      const gNode = node as GraphNode;
      const size = gNode.val || 12;
      const isHighlighted = highlightedNode === gNode.id;
      const isDimmed = highlightedNode && !isHighlighted && !highlightedLinks.has(`${highlightedNode}-${gNode.id}`) && !highlightedLinks.has(`${gNode.id}-${highlightedNode}`);

      ctx.save();

      if (isDimmed) {
        ctx.globalAlpha = 0.15;
      }

      // For content (movie/tv) and person nodes with images — draw circular poster
      if (gNode.img && (gNode.type === 'movie' || gNode.type === 'tv' || gNode.type === 'person')) {
        const img = loadImage(gNode.img);
        const radius = size / 2;

        // Outer ring glow
        if (isHighlighted) {
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, radius + 4, 0, 2 * Math.PI);
          ctx.strokeStyle = gNode.color || '#e50914';
          ctx.lineWidth = 3;
          ctx.shadowColor = gNode.color || '#e50914';
          ctx.shadowBlur = 20;
          ctx.stroke();
          ctx.shadowBlur = 0;
        }

        // Border ring
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, radius + 2, 0, 2 * Math.PI);
        ctx.fillStyle = gNode.color || '#e50914';
        ctx.fill();

        // Clip circle and draw poster
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, radius, 0, 2 * Math.PI);
        ctx.closePath();
        ctx.clip();

        if (img) {
          // Draw image centered & cropped
          const imgAspect = img.width / img.height;
          let drawW = radius * 2;
          let drawH = radius * 2;
          if (imgAspect > 1) {
            drawW = drawH * imgAspect;
          } else {
            drawH = drawW / imgAspect;
          }
          ctx.drawImage(img, node.x! - drawW / 2, node.y! - drawH / 2, drawW, drawH);
        } else {
          // Fallback: colored circle
          ctx.fillStyle = gNode.color || '#333';
          ctx.fill();
        }

        ctx.restore();
        ctx.save();
        if (isDimmed) ctx.globalAlpha = 0.15;

        // Label below — only when zoomed in enough or highlighted
        if (isHighlighted || globalScale > 2.5) {
          const label = gNode.label.length > 20 ? gNode.label.slice(0, 18) + '…' : gNode.label;
          const fontSize = Math.max(6, Math.min(8, 8 / globalScale));
          ctx.font = `600 ${fontSize}px Inter, system-ui, -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';

          // Text background for readability
          const textW = ctx.measureText(label).width;
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.beginPath();
          const bgPad = 3;
          const bgX = node.x! - textW / 2 - bgPad;
          const bgY = node.y! + radius + 2;
          const bgW = textW + bgPad * 2;
          const bgH = fontSize + bgPad * 2;
          const bgR = 3;
          ctx.moveTo(bgX + bgR, bgY);
          ctx.arcTo(bgX + bgW, bgY, bgX + bgW, bgY + bgH, bgR);
          ctx.arcTo(bgX + bgW, bgY + bgH, bgX, bgY + bgH, bgR);
          ctx.arcTo(bgX, bgY + bgH, bgX, bgY, bgR);
          ctx.arcTo(bgX, bgY, bgX + bgW, bgY, bgR);
          ctx.fill();

          ctx.fillStyle = '#fff';
          ctx.fillText(label, node.x!, bgY + bgPad);
        }
      }

      // Genre nodes — hexagon-ish shape
      else if (gNode.type === 'genre') {
        const r = size / 2;

        if (isHighlighted) {
          ctx.shadowColor = gNode.color || '#8b5cf6';
          ctx.shadowBlur = 18;
        }

        // Draw a rounded hexagon
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const angle = (Math.PI / 3) * i - Math.PI / 2;
          const px = node.x! + r * Math.cos(angle);
          const py = node.y! + r * Math.sin(angle);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();

        // Gradient fill
        const gradient = ctx.createRadialGradient(node.x!, node.y!, 0, node.x!, node.y!, r);
        gradient.addColorStop(0, gNode.color || '#8b5cf6');
        gradient.addColorStop(1, 'rgba(139, 92, 246, 0.3)');
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.strokeStyle = gNode.color || '#8b5cf6';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Label — always show inside genre hexagons but smaller
        if (globalScale > 0.4) {
          const maxLabelLen = globalScale > 1.5 ? 14 : 8;
          const label = gNode.label.length > maxLabelLen ? gNode.label.slice(0, maxLabelLen - 1) + '…' : gNode.label;
          const fontSize = Math.max(5, Math.min(7, 7 / globalScale));
          ctx.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#fff';
          ctx.fillText(label, node.x!, node.y!);
        }
      }

      // Fallback circles
      else {
        const r = size / 2;
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
        ctx.fillStyle = gNode.color || '#555';
        ctx.fill();

        if (isHighlighted) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        if (isHighlighted || globalScale > 2.5) {
          const label = gNode.label.length > 18 ? gNode.label.slice(0, 16) + '…' : gNode.label;
          const fontSize = Math.max(5, 7 / globalScale);
          ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = '#fff';
          ctx.fillText(label, node.x!, node.y! + r + 3);
        }
      }

      ctx.restore();
    },
    [highlightedNode, highlightedLinks]
  );

  // ─── Custom link renderer ─────────────────────────────────────────────────

  const paintLink = useCallback(
    (link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (!Number.isFinite(link.source?.x) || !Number.isFinite(link.source?.y) ||
          !Number.isFinite(link.target?.x) || !Number.isFinite(link.target?.y)) return;
      const srcId = typeof link.source === 'object' ? link.source.id : link.source;
      const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
      const isHighlighted = highlightedLinks.has(`${srcId}-${tgtId}`) || highlightedLinks.has(`${tgtId}-${srcId}`);
      const isDimmed = highlightedNode && !isHighlighted;

      const sx = link.source.x || 0;
      const sy = link.source.y || 0;
      const tx = link.target.x || 0;
      const ty = link.target.y || 0;

      ctx.save();

      // Link color based on type
      const colors: Record<string, string> = {
        actor: '#f59e0b',
        director: '#ef4444',
        genre: '#8b5cf6',
        similar: '#e50914',
        recommendation: '#3b82f6',
        company: '#10b981',
      };

      const linkColor = colors[link.type] || '#444';

      ctx.globalAlpha = isDimmed ? 0.04 : isHighlighted ? 0.7 : 0.15;

      // Draw line
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = linkColor;
      ctx.lineWidth = isHighlighted ? 2 : 0.8;

      if (link.type === 'similar' || link.type === 'recommendation') {
        ctx.setLineDash([4, 4]);
      }

      ctx.stroke();
      ctx.setLineDash([]);

      // Link label only when highlighted AND really zoomed in
      if (isHighlighted && globalScale > 2.5) {
        const midX = (sx + tx) / 2;
        const midY = (sy + ty) / 2;
        const label = link.label || t(LINK_LABELS[link.type]) || '';

        ctx.globalAlpha = 0.9;
        const fontSize = Math.max(7, 8 / globalScale);
        ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Background pill
        const textWidth = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        const padding = 3;
        ctx.beginPath();
        const pillW = textWidth + padding * 2;
        const pillH = fontSize + padding * 2;
        const pillX = midX - pillW / 2;
        const pillY = midY - pillH / 2;
        const pillR = 4;
        ctx.moveTo(pillX + pillR, pillY);
        ctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillH, pillR);
        ctx.arcTo(pillX + pillW, pillY + pillH, pillX, pillY + pillH, pillR);
        ctx.arcTo(pillX, pillY + pillH, pillX, pillY, pillR);
        ctx.arcTo(pillX, pillY, pillX + pillW, pillY, pillR);
        ctx.fill();

        ctx.fillStyle = linkColor;
        ctx.fillText(label, midX, midY);
      }

      ctx.restore();
    },
    [highlightedNode, highlightedLinks]
  );

  // ─── Stats ─────────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const movies = graphData.nodes.filter((n) => n.type === 'movie').length;
    const tvShows = graphData.nodes.filter((n) => n.type === 'tv').length;
    const people = graphData.nodes.filter((n) => n.type === 'person').length;
    return { nodes: graphData.nodes.length, links: graphData.links.length, movies, tvShows, people };
  }, [graphData]);

  // ─── Has graph loaded ──────────────────────────────────────────────────────

  const hasGraph = graphData.nodes.length > 0;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <SquareBackground squareSize={48} borderColor="rgba(229, 9, 20, 0.10)" className="cinegraph-page">
      <div className="cinegraph-header">
        <div className="cinegraph-title-container">
          {hasGraph && (
            <motion.button
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              onClick={() => {
                setGraphData({ nodes: [], links: [] });
                setRootNode(null);
                setSelectedNode(null);
                setSearchParams({});
              }}
              className="cinegraph-control-btn"
              style={{ padding: '8px 12px' }}
            >
              <ArrowLeft size={16} />
            </motion.button>
          )}
          <h1 className="cinegraph-title">
            <Network size={36} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 10 }} />
            {t('cinegraph.title')}
          </h1>
          <button className="cinegraph-help-btn" onClick={() => setShowSettings(true)}>
            <Settings2 size={18} />
          </button>
          <button className="cinegraph-help-btn" onClick={() => setShowHelp(true)}>
            <HelpCircle size={18} />
          </button>
        </div>
        <p className="cinegraph-subtitle">
          {hasGraph
            ? t('cinegraph.exploringUniverse', { title: rootNode?.title })
            : t('cinegraph.exploreHiddenConnections')}
        </p>

        {/* Search bar */}
        <div className="cinegraph-search-container" ref={searchContainerRef}>
          <div className="cinegraph-search-wrapper">
            <Search size={18} className="cinegraph-search-icon" />
            <input
              type="text"
              className="cinegraph-search-input"
              placeholder={t('cinegraph.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              onFocus={() => searchResults.length > 0 && setShowResults(true)}
            />
            {searchQuery && (
              <button
                className="cinegraph-search-clear"
                onClick={() => {
                  setSearchQuery('');
                  setSearchResults([]);
                  setShowResults(false);
                }}
              >
                <X size={16} />
              </button>
            )}
          </div>

          <AnimatePresence>
            {showResults && (
              <motion.div
                className="cinegraph-search-results"
                initial={{ opacity: 0, y: -8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.98 }}
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                onWheel={(e) => e.stopPropagation()}
              >
                {searchLoading ? (
                  <div style={{ padding: '24px', display: 'flex', justifyContent: 'center' }}>
                    <Loader size={20} className="animate-spin" style={{ color: '#e50914' }} />
                  </div>
                ) : searchResults.length > 0 ? (
                  searchResults.map((item) => (
                    <div
                      key={`${item.type}-${item.id}`}
                      className="cinegraph-search-result-item"
                      role="button"
                      tabIndex={0}
                      data-interactive
                      onClick={() => handleSelectResult(item)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleSelectResult(item);
                        }
                      }}
                    >
                      {item.poster ? (
                        <img src={item.poster} alt="" className="cinegraph-search-result-poster" />
                      ) : (
                        <div className="cinegraph-search-result-poster-placeholder">
                          <Film size={16} />
                        </div>
                      )}
                      <div className="cinegraph-search-result-info">
                        <div className="cinegraph-search-result-title">{item.title}</div>
                        <div className="cinegraph-search-result-meta">
                          <span className={`cinegraph-type-badge ${item.type}`}>
                            {item.type === 'movie' ? t('cinegraph.filmLabel') : t('cinegraph.seriesLabel')}
                          </span>
                          {item.year && <span>{item.year}</span>}
                          {item.rating > 0 && (
                            <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                              <Star size={11} fill="#fbbf24" color="#fbbf24" />
                              {item.rating.toFixed(1)}
                            </span>
                          )}
                        </div>
                      </div>
                      <GitBranch size={16} style={{ color: '#6b7280', flexShrink: 0 }} />
                    </div>
                  ))
                ) : searchQuery.length >= 2 ? (
                  <div style={{ padding: '24px', textAlign: 'center', color: '#6b7280', fontSize: '0.9rem' }}>
                    {t('cinegraph.noResultsFound')}
                  </div>
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ─── Loading State ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {loading && (
          <motion.div
            className="cinegraph-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="cinegraph-loading-orb" />
            <div className="cinegraph-loading-text">{loadingText}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Graph View ─────────────────────────────────────────────────── */}
      {hasGraph && !loading && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6 }}
        >
          {/* Stats bar */}
          <div className="cinegraph-stats">
            <div className="cinegraph-stat">
              <div className="cinegraph-stat-value">{stats.nodes}</div>
              <div className="cinegraph-stat-label">{t('cinegraph.nodesStat')}</div>
            </div>
            <div className="cinegraph-stat">
              <div className="cinegraph-stat-value">{stats.links}</div>
              <div className="cinegraph-stat-label">{t('cinegraph.connectionsStat')}</div>
            </div>
            <div className="cinegraph-stat">
              <div className="cinegraph-stat-value">{stats.movies + stats.tvShows}</div>
              <div className="cinegraph-stat-label">{t('cinegraph.contentsStat')}</div>
            </div>
            <div className="cinegraph-stat">
              <div className="cinegraph-stat-value">{stats.people}</div>
              <div className="cinegraph-stat-label">{t('cinegraph.artistsStat')}</div>
            </div>
          </div>

          {/* Legend / Filters */}
          <div className="cinegraph-legend">
            {LEGEND_ITEMS.map((item) => (
              <button
                key={item.type}
                className={`cinegraph-legend-chip ${activeTypes.has(item.type) ? 'active' : 'inactive'}`}
                style={{ '--chip-color': item.color } as React.CSSProperties}
                onClick={() => toggleType(item.type)}
              >
                <span className="cinegraph-legend-dot" style={{ backgroundColor: item.color }} />
                {item.icon}
                {t(item.labelKey)}
              </button>
            ))}
          </div>

          {/* Force Graph */}
          <div className="cinegraph-graph-container" ref={containerRef}>
            <Suspense
              fallback={
                <div
                  className="flex items-center justify-center"
                  style={{ width: dimensions.width, height: dimensions.height }}
                >
                  <Loader className="animate-spin text-gray-400" size={32} />
                </div>
              }
            >
              <ForceGraph2D
                ref={graphRef as any}
                graphData={filteredData}
                width={dimensions.width}
                height={dimensions.height}
                backgroundColor="rgba(0,0,0,0)"
                nodeCanvasObject={paintNode}
                nodePointerAreaPaint={(node: any, color, ctx) => {
                  const gNode = node as GraphNode;
                  const size = gNode.val || 12;
                  let r: number;
                  if (gNode.img && (gNode.type === 'movie' || gNode.type === 'tv' || gNode.type === 'person')) {
                    r = size / 2 + 2;
                  } else {
                    r = size / 2 + 1;
                  }
                  r = Math.max(r, 12);
                  ctx.beginPath();
                  ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
                  ctx.fillStyle = color;
                  ctx.fill();
                }}
                linkCanvasObject={paintLink}
                onNodeHover={handleNodeHover}
                onNodeClick={handleNodeClick}
                onNodeRightClick={handleNodeDblClick}
                onNodeDragEnd={(node: any, translate: any) => {
                  const dx = translate?.x ?? 0;
                  const dy = translate?.y ?? 0;
                  if (Math.hypot(dx, dy) < 4) {
                    handleNodeClick(node);
                    return;
                  }
                  node.fx = node.x;
                  node.fy = node.y;
                }}
                d3AlphaDecay={0.05}
                d3VelocityDecay={0.4}
                cooldownTicks={80}
                warmupTicks={50}
                enableNodeDrag={true}
                enableZoomInteraction={true}
                enablePanInteraction={true}
                minZoom={0.2}
                maxZoom={8}
              />
            </Suspense>

            {/* Controls */}
            <div className="cinegraph-controls">
              <button
                className="cinegraph-control-btn"
                onClick={() => graphRef.current?.zoomToFit(400, 60)}
                title={t('cinegraph.recenter')}
              >
                <Maximize2 size={14} />
                <span>{t('cinegraph.recenter')}</span>
              </button>
              <button
                className="cinegraph-control-btn"
                onClick={() => {
                  const zoom = graphRef.current?.zoom();
                  if (zoom) graphRef.current?.zoom(zoom * 1.5, 300);
                }}
                title={t('cinegraph.zoomIn')}
              >
                <ZoomIn size={14} />
              </button>
              <button
                className="cinegraph-control-btn"
                onClick={() => {
                  const zoom = graphRef.current?.zoom();
                  if (zoom) graphRef.current?.zoom(zoom / 1.5, 300);
                }}
                title={t('cinegraph.zoomOut')}
              >
                <ZoomOut size={14} />
              </button>
            </div>
          </div>
        </motion.div>
      )}

      {/* ─── Tooltip (portaled to body so global fixed Header can't cover it) ─ */}
      {createPortal(
        <AnimatePresence>
          {tooltip && (
            <motion.div
              className="cinegraph-tooltip"
              style={{ left: tooltip.x + 12, top: tooltip.y - 12 }}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
            >
              <div className="cinegraph-tooltip-header">
                {tooltip.node.img ? (
                  <img src={tooltip.node.img} alt="" className="cinegraph-tooltip-poster" />
                ) : (
                  <div className="cinegraph-tooltip-poster-placeholder">
                    {tooltip.node.type === 'person' ? <User size={20} /> : <Film size={20} />}
                  </div>
                )}
                <div>
                  <div className="cinegraph-tooltip-title">{tooltip.node.label}</div>
                  <div className="cinegraph-tooltip-meta">
                    <span className={`cinegraph-type-badge ${tooltip.node.type}`}>
                      {tooltip.node.type === 'movie' ? t('cinegraph.filmLabel') : tooltip.node.type === 'tv' ? t('cinegraph.seriesLabel') : tooltip.node.type === 'person' ? t('cinegraph.artistLabel') : t('cinegraph.genresLabel')}
                    </span>
                    {tooltip.node.year && <span>{tooltip.node.year}</span>}
                    {tooltip.node.rating && tooltip.node.rating > 0 && (
                      <span className="cinegraph-tooltip-rating">
                        <Star size={11} fill="#fbbf24" />
                        {tooltip.node.rating.toFixed(1)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {tooltip.node.overview && (
                <p className="cinegraph-tooltip-overview">{tooltip.node.overview}</p>
              )}
              <div className="cinegraph-tooltip-action">{t('cinegraph.clickForDetails')}</div>
            </motion.div>
          )}
        </AnimatePresence>,
        getOverlayPortalRoot()
      )}

      {/* ─── Detail Panel (portaled to body so close button & top area are clickable) ─ */}
      {createPortal(
        <AnimatePresence>
          {selectedNode && (
            <motion.div
              className="cinegraph-detail-panel"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              onWheel={(e) => e.stopPropagation()}
            >
            <div className="cinegraph-detail-backdrop">
              {selectedNode.backdrop ? (
                <img src={selectedNode.backdrop} alt="" />
              ) : selectedNode.img ? (
                <img src={selectedNode.img} alt="" style={{ objectPosition: 'top' }} />
              ) : (
                <div style={{ background: `linear-gradient(135deg, ${selectedNode.color}33, #111)`, width: '100%', height: '100%' }} />
              )}
              <button
                className="cinegraph-detail-close"
                onClick={() => setSelectedNode(null)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="cinegraph-detail-content">
              <h2 className="cinegraph-detail-title">{selectedNode.label}</h2>

              <div className="cinegraph-detail-meta">
                <span
                  className={`cinegraph-type-badge ${selectedNode.type}`}
                  style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                >
                  {selectedNode.type === 'movie' ? t('cinegraph.movieType') : selectedNode.type === 'tv' ? t('cinegraph.tvType') : selectedNode.type === 'person' ? t('cinegraph.personType') : t('cinegraph.genreType')}
                </span>
                {selectedNode.year && (
                  <span style={{ color: '#9ca3af', fontSize: '0.85rem' }}>{selectedNode.year}</span>
                )}
                {selectedNode.rating && selectedNode.rating > 0 && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#fbbf24', fontSize: '0.85rem' }}>
                    <Star size={14} fill="#fbbf24" />
                    {selectedNode.rating.toFixed(1)}
                  </span>
                )}
              </div>

              {selectedNode.overview && (
                <p className="cinegraph-detail-overview">{selectedNode.overview}</p>
              )}

              <div className="cinegraph-detail-links">
                {(selectedNode.type === 'movie' || selectedNode.type === 'tv') && (
                  <button
                    className="cinegraph-detail-link primary"
                    onClick={() => navigate(`/${selectedNode.type}/${encodeId(selectedNode.tmdbId)}`)}
                  >
                    <Eye size={16} />
                    {t('cinegraph.viewRecord')}
                  </button>
                )}
                {selectedNode.type === 'person' && (
                  <button
                    className="cinegraph-detail-link primary"
                    onClick={() => navigate(`/person/${selectedNode.tmdbId}`)}
                  >
                    <User size={16} />
                    {t('cinegraph.viewProfile')}
                  </button>
                )}
                {(selectedNode.type === 'movie' || selectedNode.type === 'tv' || selectedNode.type === 'person') && (
                  <button
                    className="cinegraph-detail-link secondary"
                    onClick={() => loadGraph(selectedNode.type as any, selectedNode.tmdbId, selectedNode.label)}
                  >
                    <Network size={16} />
                    {t('cinegraph.exploreNetwork')}
                  </button>
                )}
              </div>

              {/* Connections list */}
              <div className="cinegraph-detail-connections">
                <h3>
                  <GitBranch size={16} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
                  {t('cinegraph.connectionsStat')} ({getNodeConnections(selectedNode.id).length})
                </h3>
                {getNodeConnections(selectedNode.id).map(({ node: connNode, link }, i) => (
                  <div
                    key={i}
                    className="cinegraph-connection-item"
                    role="button"
                    tabIndex={0}
                    data-interactive
                    onClick={() => {
                      setSelectedNode(connNode);
                      if (graphRef.current) {
                        const n = connNode as any;
                        if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
                          graphRef.current.centerAt(n.x, n.y, 1000);
                          graphRef.current.zoom(3, 1000);
                        }
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedNode(connNode);
                        if (graphRef.current) {
                          const n = connNode as any;
                          if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
                            graphRef.current.centerAt(n.x, n.y, 1000);
                            graphRef.current.zoom(3, 1000);
                          }
                        }
                      }
                    }}
                  >
                    {connNode.img ? (
                      <img
                        src={connNode.img}
                        alt=""
                        style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${connNode.color}` }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: '50%',
                          background: `${connNode.color}33`,
                          border: `2px solid ${connNode.color}`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {connNode.type === 'person' ? <User size={14} color={connNode.color} /> :
                          connNode.type === 'genre' ? <Sparkles size={14} color={connNode.color} /> :
                            <Film size={14} color={connNode.color} />}
                      </div>
                    )}
                    <span className="cinegraph-connection-label">{connNode.label}</span>
                    <span
                      className="cinegraph-connection-type"
                      style={{ background: `${connNode.color}22`, color: connNode.color }}
                    >
                      {t(LINK_LABELS[link.type]) || link.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
        </AnimatePresence>,
        getOverlayPortalRoot()
      )}

      {/* ─── Help Modal (portaled like WatchPartyTutorial) ──────────────── */}
      {(showHelp || helpClosing) && createPortal(
        <AnimatePresence mode="wait">
          {showHelp && !helpClosing && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) closeHelp(); }}
              onWheel={(e) => e.stopPropagation()}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-900 border border-white/10 rounded-2xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col max-h-[85dvh]"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="p-4 md:p-6 border-b border-white/10 flex justify-between items-center shrink-0">
                  <h3 className="text-lg md:text-xl font-bold text-white flex items-center gap-2">
                    <HelpCircle className="text-red-500 h-5 w-5 md:h-6 md:w-6" />
                    {t('cinegraph.howToUse')}
                  </h3>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={closeHelp}
                    className="text-white/50 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors"
                  >
                    <X className="w-5 h-5 md:w-6 md:h-6" />
                  </motion.button>
                </div>

                {/* Content — scrollable */}
                <div
                  className="p-4 md:p-6 flex-1 overflow-y-auto custom-scrollbar overscroll-contain"
                  style={{ WebkitOverflowScrolling: 'touch' }}
                  onWheel={(e) => e.stopPropagation()}
                >
                  <p className="text-white/70 text-sm md:text-base mb-5 leading-relaxed text-center">
                    {t('cinegraph.visualizesDescription')}
                  </p>

                  <div className="flex flex-col gap-3">
                    {[
                      { icon: '🔍', title: t('cinegraph.searchTitle'), desc: t('cinegraph.searchDesc') },
                      { icon: '🖱️', title: t('cinegraph.interactTitle'), desc: t('cinegraph.interactDesc') },
                      { icon: '🔎', title: t('cinegraph.navigateTitle'), desc: t('cinegraph.navigateDesc') },
                      { icon: '🎨', title: t('cinegraph.filterTitle'), desc: t('cinegraph.filterDesc') },
                      { icon: '📋', title: t('cinegraph.detailPanelTitle'), desc: t('cinegraph.detailPanelDesc') },
                    ].map((item, i) => (
                      <div key={i} className="flex gap-3 items-start p-3 md:p-4 rounded-lg bg-white/5 border border-white/5 hover:bg-white/[0.08] transition-colors">
                        <span className="text-xl md:text-2xl shrink-0 mt-0.5">{item.icon}</span>
                        <div>
                          <h4 className="font-semibold text-white text-sm md:text-base">{item.title}</h4>
                          <p className="text-white/60 text-xs md:text-sm mt-1 leading-relaxed">{item.desc}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        getOverlayPortalRoot()
      )}

      {/* ─── Settings Modal ─────────────────────────────────────────────── */}
      {(showSettings || settingsClosing) && createPortal(
        <AnimatePresence mode="wait">
          {showSettings && !settingsClosing && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) closeSettings(); }}
              onWheel={(e) => e.stopPropagation()}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-900 border border-white/10 rounded-2xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col max-h-[85dvh]"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="p-4 md:p-6 border-b border-white/10 flex justify-between items-center shrink-0">
                  <h3 className="text-lg md:text-xl font-bold text-white flex items-center gap-2">
                    <Settings2 className="text-red-500 h-5 w-5 md:h-6 md:w-6" />
                    {t('cinegraph.customizeGraph')}
                  </h3>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={closeSettings}
                    className="text-white/50 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors"
                  >
                    <X className="w-5 h-5 md:w-6 md:h-6" />
                  </motion.button>
                </div>

                {/* Content — scrollable */}
                <div
                  className="p-4 md:p-6 flex-1 overflow-y-auto custom-scrollbar overscroll-contain"
                  style={{ WebkitOverflowScrolling: 'touch' }}
                  onWheel={(e) => e.stopPropagation()}
                >
                  <p className="text-white/50 text-xs md:text-sm mb-5 text-center">
                    {t('cinegraph.settingsDescription')}
                  </p>

                  <div className="flex flex-col gap-4">

                    {/* ── Toggle: Actors ── */}
                    <div className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5">
                      <div className="flex items-center gap-3">
                        <User size={18} className="text-amber-400 shrink-0" />
                        <div>
                          <div className="text-sm font-semibold text-white">{t('cinegraph.actorsCast')}</div>
                          <div className="text-xs text-white/50">{t('cinegraph.addMainActors')}</div>
                        </div>
                      </div>
                      <button
                        onClick={() => setGraphOptions(o => ({ ...o, actors: !o.actors }))}
                        className={`w-11 h-6 rounded-full transition-colors relative ${graphOptions.actors ? 'bg-red-600' : 'bg-white/20'}`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${graphOptions.actors ? 'translate-x-5' : ''}`} />
                      </button>
                    </div>

                    {/* Actor limit slider */}
                    {graphOptions.actors && (
                      <div className="pl-8 pr-3 -mt-2">
                        <label className="flex items-center justify-between text-xs text-white/60 mb-1">
                          <span>{t('cinegraph.maxActors')}</span>
                          <span className="font-mono text-white/80 bg-white/10 px-2 py-0.5 rounded">{graphOptions.actorLimit}</span>
                        </label>
                        <input
                          type="range"
                          min={2}
                          max={20}
                          value={graphOptions.actorLimit}
                          onChange={(e) => setGraphOptions(o => ({ ...o, actorLimit: parseInt(e.target.value) }))}
                          className="w-full accent-red-500 h-1.5"
                        />
                        <div className="flex justify-between text-[10px] text-white/30 mt-0.5">
                          <span>2</span>
                          <span>20</span>
                        </div>
                      </div>
                    )}

                    {/* ── Toggle: Directors ── */}
                    <div className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5">
                      <div className="flex items-center gap-3">
                        <Film size={18} className="text-red-400 shrink-0" />
                        <div>
                          <div className="text-sm font-semibold text-white">{t('cinegraph.directors')}</div>
                          <div className="text-xs text-white/50">{t('cinegraph.addDirectors')}</div>
                        </div>
                      </div>
                      <button
                        onClick={() => setGraphOptions(o => ({ ...o, directors: !o.directors }))}
                        className={`w-11 h-6 rounded-full transition-colors relative ${graphOptions.directors ? 'bg-red-600' : 'bg-white/20'}`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${graphOptions.directors ? 'translate-x-5' : ''}`} />
                      </button>
                    </div>

                    {/* ── Toggle: Genres ── */}
                    <div className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5">
                      <div className="flex items-center gap-3">
                        <Sparkles size={18} className="text-purple-400 shrink-0" />
                        <div>
                          <div className="text-sm font-semibold text-white">{t('cinegraph.genresLabel')}</div>
                          <div className="text-xs text-white/50">{t('cinegraph.addGenreNodes')}</div>
                        </div>
                      </div>
                      <button
                        onClick={() => setGraphOptions(o => ({ ...o, genres: !o.genres }))}
                        className={`w-11 h-6 rounded-full transition-colors relative ${graphOptions.genres ? 'bg-red-600' : 'bg-white/20'}`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${graphOptions.genres ? 'translate-x-5' : ''}`} />
                      </button>
                    </div>

                    {/* ── Toggle: Similar ── */}
                    <div className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5">
                      <div className="flex items-center gap-3">
                        <GitBranch size={18} className="text-red-500 shrink-0" />
                        <div>
                          <div className="text-sm font-semibold text-white">{t('cinegraph.similarsLabel')}</div>
                          <div className="text-xs text-white/50">{t('cinegraph.similarContent')}</div>
                        </div>
                      </div>
                      <button
                        onClick={() => setGraphOptions(o => ({ ...o, similar: !o.similar }))}
                        className={`w-11 h-6 rounded-full transition-colors relative ${graphOptions.similar ? 'bg-red-600' : 'bg-white/20'}`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${graphOptions.similar ? 'translate-x-5' : ''}`} />
                      </button>
                    </div>

                    {/* Similar limit slider */}
                    {graphOptions.similar && (
                      <div className="pl-8 pr-3 -mt-2">
                        <label className="flex items-center justify-between text-xs text-white/60 mb-1">
                          <span>{t('cinegraph.maxSimilar')}</span>
                          <span className="font-mono text-white/80 bg-white/10 px-2 py-0.5 rounded">{graphOptions.similarLimit}</span>
                        </label>
                        <input
                          type="range"
                          min={1}
                          max={15}
                          value={graphOptions.similarLimit}
                          onChange={(e) => setGraphOptions(o => ({ ...o, similarLimit: parseInt(e.target.value) }))}
                          className="w-full accent-red-500 h-1.5"
                        />
                        <div className="flex justify-between text-[10px] text-white/30 mt-0.5">
                          <span>1</span>
                          <span>15</span>
                        </div>
                      </div>
                    )}

                    {/* ── Toggle: Recommendations ── */}
                    <div className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5">
                      <div className="flex items-center gap-3">
                        <Star size={18} className="text-blue-400 shrink-0" />
                        <div>
                          <div className="text-sm font-semibold text-white">{t('cinegraph.recommendations')}</div>
                          <div className="text-xs text-white/50">{t('cinegraph.recommendedByTmdb')}</div>
                        </div>
                      </div>
                      <button
                        onClick={() => setGraphOptions(o => ({ ...o, recommendations: !o.recommendations }))}
                        className={`w-11 h-6 rounded-full transition-colors relative ${graphOptions.recommendations ? 'bg-red-600' : 'bg-white/20'}`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${graphOptions.recommendations ? 'translate-x-5' : ''}`} />
                      </button>
                    </div>

                    {/* Recommendations limit slider */}
                    {graphOptions.recommendations && (
                      <div className="pl-8 pr-3 -mt-2">
                        <label className="flex items-center justify-between text-xs text-white/60 mb-1">
                          <span>{t('cinegraph.maxRecommendations')}</span>
                          <span className="font-mono text-white/80 bg-white/10 px-2 py-0.5 rounded">{graphOptions.recommendationLimit}</span>
                        </label>
                        <input
                          type="range"
                          min={1}
                          max={15}
                          value={graphOptions.recommendationLimit}
                          onChange={(e) => setGraphOptions(o => ({ ...o, recommendationLimit: parseInt(e.target.value) }))}
                          className="w-full accent-red-500 h-1.5"
                        />
                        <div className="flex justify-between text-[10px] text-white/30 mt-0.5">
                          <span>1</span>
                          <span>15</span>
                        </div>
                      </div>
                    )}

                    {/* ── Depth ── */}
                    <div className="p-3 rounded-lg bg-white/5 border border-white/5">
                      <div className="flex items-center gap-3 mb-2">
                        <Network size={18} className="text-emerald-400 shrink-0" />
                        <div>
                          <div className="text-sm font-semibold text-white">{t('cinegraph.explorationDepth')}</div>
                          <div className="text-xs text-white/50">{t('cinegraph.depthDescription')}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 mt-2">
                        {[0, 1, 2, 3].map((d) => (
                          <button
                            key={d}
                            onClick={() => setGraphOptions(o => ({ ...o, depth: d }))}
                            className={`flex-1 py-1.5 rounded-lg text-sm font-bold transition-all ${
                              graphOptions.depth === d
                                ? 'bg-red-600 text-white shadow-lg shadow-red-600/30'
                                : 'bg-white/10 text-white/50 hover:bg-white/15 hover:text-white/80'
                            }`}
                          >
                            {d}
                          </button>
                        ))}
                      </div>
                      {graphOptions.depth >= 2 && (
                        <p className="text-[11px] text-amber-400/80 mt-2">
                          {t('cinegraph.depthWarning')}
                        </p>
                      )}
                    </div>

                    {/* ── Reset ── */}
                    <button
                      onClick={() => setGraphOptions({ ...DEFAULT_GRAPH_OPTIONS })}
                      className="mt-2 w-full py-2.5 rounded-lg border border-white/10 bg-white/5 text-white/70 text-sm font-medium hover:bg-white/10 hover:text-white transition-colors"
                    >
                      {t('cinegraph.resetSettings')}
                    </button>

                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        getOverlayPortalRoot()
      )}

      {/* ─── Trending / Start Screen ────────────────────────────────────── */}
      {!hasGraph && !loading && (
        <motion.div
          className="cinegraph-start-grid"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.5 }}
        >
          <h2>{t('cinegraph.trendingChoose')}</h2>
          <div className="cinegraph-start-items">
            {trending.map((item) => (
              <motion.div
                key={`${item.type}-${item.id}`}
                className="cinegraph-start-item"
                role="button"
                tabIndex={0}
                data-interactive
                onClick={() => handleSelectTrending(item)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelectTrending(item);
                  }
                }}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
              >
                {item.poster ? (
                  <img src={item.poster} alt={item.title} loading="lazy" />
                ) : (
                  <div style={{ aspectRatio: '2/3', background: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Film size={28} color="#4b5563" />
                  </div>
                )}
                <div className="cinegraph-start-item-info">
                  <div className="cinegraph-start-item-title">{item.title}</div>
                  <div className="cinegraph-start-item-meta">
                    {item.type === 'movie' ? t('cinegraph.filmLabel') : t('cinegraph.seriesLabel')} {item.year && `• ${item.year}`}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
      )}
    </SquareBackground>
  );
};

export default CineGraphPage;
