import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Share,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  subscribeLogs,
  clearLogs,
  type LogEntry,
  type LogLevel,
} from '../services/debugLog';

type Props = {
  visible: boolean;
  onClose: () => void;
};

type Filter = 'all' | LogLevel;

const LEVEL_COLOR: Record<LogLevel, string> = {
  log: '#cfcfcf',
  info: '#60a5fa',
  warn: '#f59e0b',
  error: '#ef4444',
};

const SOURCE_COLOR: Record<LogEntry['source'], string> = {
  app: '#8b5cf6',
  web: '#22c55e',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${d
    .getMilliseconds()
    .toString()
    .padStart(3, '0')}`;
}

const FILTERS: Filter[] = ['all', 'log', 'info', 'warn', 'error'];

export default function DebugConsole({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!visible) return;
    return subscribeLogs(setLogs);
  }, [visible]);

  const filtered = useMemo(
    () => (filter === 'all' ? logs : logs.filter((l) => l.level === filter)),
    [logs, filter],
  );

  useEffect(() => {
    if (visible && autoScroll) {
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
    }
  }, [filtered, visible, autoScroll]);

  const counts = useMemo(() => {
    let warn = 0;
    let error = 0;
    for (const l of logs) {
      if (l.level === 'warn') warn++;
      else if (l.level === 'error') error++;
    }
    return { total: logs.length, warn, error };
  }, [logs]);

  const onShare = useCallback(async () => {
    if (!filtered.length) return;
    const text = filtered
      .map(
        (l) =>
          `${formatTime(l.ts)} [${l.source}] ${l.level.toUpperCase()}: ${l.message}`,
      )
      .join('\n');
    try {
      await Share.share({ message: text });
    } catch {
      // utilisateur a annulé
    }
  }, [filtered]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen">
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>Fermer</Text>
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.title}>Console</Text>
            <Text style={styles.subtitle}>
              {counts.total} lignes · {counts.warn} warn · {counts.error} err
            </Text>
          </View>
          <TouchableOpacity onPress={onShare} style={styles.headerBtn}>
            <Text style={[styles.headerBtnText, { textAlign: 'right' }]}>Partager</Text>
          </TouchableOpacity>
        </View>

        {/* Filtres */}
        <View style={styles.filterRow}>
          {FILTERS.map((f) => {
            const active = filter === f;
            return (
              <TouchableOpacity
                key={f}
                onPress={() => setFilter(f)}
                style={[styles.chip, active && styles.chipActive]}>
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {f === 'all' ? 'Tout' : f}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Logs */}
        <ScrollView
          ref={scrollRef}
          style={styles.logs}
          contentContainerStyle={styles.logsContent}
          onScrollBeginDrag={() => setAutoScroll(false)}
          onMomentumScrollEnd={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            const atBottom =
              contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
            setAutoScroll(atBottom);
          }}>
          {filtered.length === 0 ? (
            <Text style={styles.empty}>Aucun log pour ce filtre.</Text>
          ) : (
            filtered.map((l) => (
              <View key={l.id} style={styles.line}>
                <Text style={styles.lineMeta}>
                  <Text style={styles.time}>{formatTime(l.ts)}</Text>
                  <Text style={{ color: SOURCE_COLOR[l.source] }}> {l.source}</Text>
                </Text>
                <Text style={[styles.lineMsg, { color: LEVEL_COLOR[l.level] }]}>
                  {l.message}
                </Text>
              </View>
            ))
          )}
        </ScrollView>

        {/* Footer */}
        <View style={[styles.footer, { paddingBottom: insets.bottom + 10 }]}>
          <TouchableOpacity
            onPress={() => setAutoScroll((v) => !v)}
            style={[styles.footerBtn, autoScroll && styles.footerBtnActive]}>
            <Text style={[styles.footerBtnText, autoScroll && styles.footerBtnTextActive]}>
              {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => scrollRef.current?.scrollToEnd({ animated: true })}
            style={styles.footerBtn}>
            <Text style={styles.footerBtnText}>↓ Bas</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={clearLogs} style={[styles.footerBtn, styles.clearBtn]}>
            <Text style={[styles.footerBtnText, styles.clearText]}>Effacer</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#111111',
    borderBottomWidth: 1,
    borderBottomColor: '#1f1f1f',
  },
  headerBtn: {
    width: 72,
  },
  headerBtnText: {
    color: '#8b5cf6',
    fontSize: 15,
    fontWeight: '500',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  title: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  subtitle: {
    color: '#666666',
    fontSize: 11,
    marginTop: 1,
  },
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
    backgroundColor: '#0d0d0d',
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: '#1a1a1a',
  },
  chipActive: {
    backgroundColor: '#8b5cf6',
  },
  chipText: {
    color: '#888888',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  chipTextActive: {
    color: '#ffffff',
  },
  logs: {
    flex: 1,
  },
  logsContent: {
    padding: 10,
  },
  empty: {
    color: '#555555',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 40,
  },
  line: {
    marginBottom: 8,
    borderLeftWidth: 2,
    borderLeftColor: '#1f1f1f',
    paddingLeft: 8,
  },
  lineMeta: {
    fontSize: 10,
  },
  time: {
    color: '#555555',
  },
  lineMsg: {
    fontSize: 12,
    marginTop: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingTop: 10,
    gap: 8,
    backgroundColor: '#111111',
    borderTopWidth: 1,
    borderTopColor: '#1f1f1f',
  },
  footerBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#1a1a1a',
  },
  footerBtnActive: {
    backgroundColor: '#8b5cf620',
  },
  footerBtnText: {
    color: '#cccccc',
    fontSize: 13,
    fontWeight: '600',
  },
  footerBtnTextActive: {
    color: '#8b5cf6',
  },
  clearBtn: {
    backgroundColor: '#ef444420',
  },
  clearText: {
    color: '#ef4444',
  },
});
