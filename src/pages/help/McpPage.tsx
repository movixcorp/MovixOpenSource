import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Bot,
  Check,
  Copy,
  MessagesSquare,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import TutoLayout, { TutoSection } from '../../components/TutoLayout';
import TutoLink from '../../components/TutoLink';

/** Seule URL à retenir : identique pour tous les clients IA. */
const MCP_URL = 'https://mcp.movix.online/mcp';
const MCP_SPEC_URL = 'https://modelcontextprotocol.io';
const MOVIX_OPEN_SOURCE_GITHUB_URL = 'https://github.com/movixcorp/MovixOpenSource';

const EXTERNAL_LINK_CLASS =
  'font-medium text-indigo-400 hover:text-indigo-300 underline underline-offset-2 decoration-indigo-500/40 hover:decoration-indigo-400';

/** Bout de code inline utilisé dans les paragraphes via <Trans>. */
const InlineCode: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <code className="px-1.5 py-0.5 rounded bg-white/10 text-zinc-100 font-mono text-[0.85em] break-all">
    {children}
  </code>
);

const CLAUDE_CODE_SNIPPET = `claude mcp add --transport http movix ${MCP_URL}`;

const CURSOR_SNIPPET = `{
  "mcpServers": {
    "movix": {
      "url": "${MCP_URL}"
    }
  }
}`;

const VSCODE_SNIPPET = `{
  "servers": {
    "movix": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`;

const LOCAL_SNIPPET = `{
  "mcpServers": {
    "movix": {
      "command": "node",
      "args": ["/path/to/movix-mcp/dist/index.js"],
      "env": {
        "TMDB_API_KEY": "ta_cle_tmdb_v4"
      }
    }
  }
}`;

interface Snippet {
  labelKey: string;
  code: string;
}

interface ClientDef {
  /** Suffixe des clés i18n : help.mcp.client<Id>Name, ...Step1, ...Note */
  id: 'Claude' | 'Chatgpt' | 'Lechat' | 'Editors';
  icon: React.ReactNode;
  stepCount: number;
  snippets?: Snippet[];
}

const CLIENTS: ClientDef[] = [
  { id: 'Claude', icon: <Sparkles className="w-4 h-4" />, stepCount: 4 },
  { id: 'Chatgpt', icon: <MessagesSquare className="w-4 h-4" />, stepCount: 4 },
  { id: 'Lechat', icon: <Bot className="w-4 h-4" />, stepCount: 3 },
  {
    id: 'Editors',
    icon: <TerminalSquare className="w-4 h-4" />,
    stepCount: 3,
    snippets: [
      { labelKey: 'help.mcp.snippetClaudeCode', code: CLAUDE_CODE_SNIPPET },
      { labelKey: 'help.mcp.snippetCursor', code: CURSOR_SNIPPET },
      { labelKey: 'help.mcp.snippetVscode', code: VSCODE_SNIPPET },
    ],
  },
];

/** Exemples de phrases → outil MCP appelé (rendus dans la section table). */
const EXAMPLE_COUNT = 8;

const McpPage: React.FC = () => {
  const { t } = useTranslation();
  const [activeClient, setActiveClient] = useState<ClientDef['id']>('Claude');
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    document.title = `${t('help.mcp.title')} — Movix`;
  }, [t]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(
        () => setCopied((current) => (current === value ? null : current)),
        2000
      );
    } catch {
      // Clipboard indisponible (contexte non sécurisé) — l'utilisateur
      // peut toujours sélectionner le texte à la main.
    }
  };

  const renderCopyButton = (value: string, extraClass = '') => {
    const isCopied = copied === value;
    return (
      <button
        type="button"
        onClick={() => copy(value)}
        aria-label={isCopied ? t('help.mcp.copied') : t('help.mcp.copy')}
        className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-semibold transition-colors ${
          isCopied
            ? 'border-green-500/40 bg-green-500/15 text-green-300'
            : 'border-white/15 bg-white/5 text-zinc-300 hover:text-white hover:bg-white/10'
        } ${extraClass}`}
      >
        {isCopied ? (
          <Check className="w-3.5 h-3.5" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
        {isCopied ? t('help.mcp.copied') : t('help.mcp.copy')}
      </button>
    );
  };

  const renderUrlCard = () => (
    <div className="rounded-xl border border-green-500/25 bg-green-500/[0.06] p-4">
      <p className="text-xs uppercase tracking-wide text-green-300/80 font-semibold mb-2">
        {t('help.mcp.urlLabel')}
      </p>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <code className="flex-1 font-mono text-sm sm:text-base text-white break-all">
          {MCP_URL}
        </code>
        {renderCopyButton(MCP_URL)}
      </div>
    </div>
  );

  const renderSnippet = (snippet: Snippet) => (
    <div key={snippet.labelKey} className="rounded-lg border border-white/10 bg-black/40">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-white/10">
        <span className="text-xs font-semibold text-zinc-300">
          {t(snippet.labelKey)}
        </span>
        {renderCopyButton(snippet.code)}
      </div>
      <pre className="px-3 py-3 overflow-x-auto text-xs leading-relaxed text-zinc-200 font-mono">
        <code>{snippet.code}</code>
      </pre>
    </div>
  );

  const renderClients = () => {
    const client = CLIENTS.find((c) => c.id === activeClient) ?? CLIENTS[0];
    return (
      <div>
        <div
          role="tablist"
          aria-label={t('help.mcp.clientsTitle')}
          className="flex flex-wrap gap-2 mb-4"
        >
          {CLIENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={c.id === activeClient}
              onClick={() => setActiveClient(c.id)}
              className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-semibold transition-colors ${
                c.id === activeClient
                  ? 'border-red-500/50 bg-red-500/15 text-white'
                  : 'border-white/10 bg-white/5 text-zinc-400 hover:text-white hover:bg-white/10'
              }`}
            >
              {c.icon}
              {t(`help.mcp.tab${c.id}`)}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          className="rounded-xl border border-white/10 bg-white/[0.03] p-5"
        >
          <h3 className="font-semibold text-white mb-4">
            {t(`help.mcp.client${client.id}Name`)}
          </h3>
          <ol className="space-y-3 mb-4">
            {Array.from({ length: client.stepCount }, (_, i) => (
              <li key={i} className="flex gap-3">
                <span className="shrink-0 w-7 h-7 rounded-full bg-red-500/20 border border-red-500/40 text-red-300 text-sm font-semibold flex items-center justify-center">
                  {i + 1}
                </span>
                <span className="flex-1 text-sm text-zinc-300 leading-relaxed pt-1">
                  <Trans
                    i18nKey={`help.mcp.client${client.id}Step${i + 1}`}
                    components={{ 1: <InlineCode /> }}
                  />
                </span>
              </li>
            ))}
          </ol>
          {client.snippets && (
            <div className="space-y-3 mb-4">
              {client.snippets.map(renderSnippet)}
            </div>
          )}
          <p className="text-xs text-zinc-400 leading-relaxed italic">
            <Trans
              i18nKey={`help.mcp.client${client.id}Note`}
              components={{ 1: <InlineCode /> }}
            />
          </p>
        </div>
      </div>
    );
  };

  const sections: TutoSection[] = [
    {
      kind: 'text',
      bodyKey: 'help.mcp.introBody',
      components: {
        1: (
          <a
            href={MCP_SPEC_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={EXTERNAL_LINK_CLASS}
          />
        ),
        2: <InlineCode />,
      },
    },
    { kind: 'visual', render: renderUrlCard },
    {
      kind: 'text',
      titleKey: 'help.mcp.whatTitle',
      bodyKey: 'help.mcp.whatBody',
      titleIcon: <Sparkles className="w-5 h-5 text-green-400" />,
    },
    {
      kind: 'text',
      titleKey: 'help.mcp.prereqTitle',
      bodyKey: 'help.mcp.prereqBody',
      components: {
        1: <TutoLink to="/help/compte" />,
        2: <TutoLink to="/help/vip" />,
      },
    },
    {
      kind: 'text',
      titleKey: 'help.mcp.clientsTitle',
      bodyKey: 'help.mcp.clientsIntro',
    },
    { kind: 'visual', render: renderClients },
    {
      kind: 'table',
      titleKey: 'help.mcp.examplesTitle',
      introKey: 'help.mcp.examplesIntro',
      headerKeys: [
        'help.mcp.examplesHeaderYouSay',
        'help.mcp.examplesHeaderToolCalled',
      ],
      rowKeys: Array.from({ length: EXAMPLE_COUNT }, (_, i) => [
        `help.mcp.example${i + 1}You`,
        `help.mcp.example${i + 1}Tool`,
      ]) as Array<[string, string]>,
      noteKey: 'help.mcp.examplesNote',
    },
    {
      kind: 'text',
      titleKey: 'help.mcp.securityTitle',
      bodyKey: 'help.mcp.securityBody',
    },
    {
      kind: 'text',
      titleKey: 'help.mcp.advancedTitle',
      bodyKey: 'help.mcp.advancedBody',
      titleIcon: <TerminalSquare className="w-5 h-5 text-zinc-400" />,
      components: {
        1: (
          <a
            href={MOVIX_OPEN_SOURCE_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={EXTERNAL_LINK_CLASS}
          />
        ),
        2: <InlineCode />,
      },
    },
    {
      kind: 'visual',
      render: () => renderSnippet({ labelKey: 'help.mcp.snippetLocal', code: LOCAL_SNIPPET }),
    },
    {
      kind: 'text',
      bodyKey: 'help.mcp.advancedNote',
      components: { 1: <InlineCode /> },
    },
    {
      kind: 'text',
      titleKey: 'help.mcp.limitsTitle',
      bodyKey: 'help.mcp.limitsBody',
      titleIcon: <AlertTriangle className="w-5 h-5 text-amber-400" />,
      components: { 1: <InlineCode /> },
    },
  ];

  return (
    <TutoLayout
      icon={<Bot className="w-10 h-10 text-green-400" />}
      title={t('help.mcp.title')}
      heroSub={t('help.mcp.heroSub')}
      sections={sections}
    />
  );
};

export default McpPage;
