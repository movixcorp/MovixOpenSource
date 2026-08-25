import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  AlertTriangle, BarChart3, Loader2, MessageSquare, RefreshCw, Sparkles, UserPlus, Users,
} from 'lucide-react';
import { fetchStatsOverview } from '../services/adminStatsService';
import type { StatsOverview, StatsRange } from '../services/adminStatsService';
import ChartCard from './stats/ChartCard';
import { CHART_COLORS, PROVIDER_COLORS, formatDayLabel, tooltipStyle } from './stats/chartTheme';

const RANGES: StatsRange[] = [7, 30, 90];
const nf = new Intl.NumberFormat('fr-FR');

const AdminStats = () => {
  const { t } = useTranslation();
  const [range, setRange] = useState<StatsRange>(30);
  const [data, setData] = useState<StatsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (r: StatsRange) => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchStatsOverview(r));
    } catch {
      setError(t('admin.stats.loadError', 'Erreur de chargement des statistiques'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const providerData = useMemo(
    () => (data ? Object.entries(data.totals.byProvider).map(([name, value]) => ({ name, value })) : []),
    [data],
  );

  const loginSeries = useMemo(
    () => (data
      ? data.sessionsPerDay.map((s, i) => ({ date: s.date, sessions: s.count, dau: data.dauPerDay[i]?.count ?? 0 }))
      : []),
    [data],
  );

  const engagementSeries = useMemo(
    () => (data
      ? data.commentsPerDay.map((c, i) => ({
          date: c.date,
          comments: c.count,
          lists: data.sharedListsPerDay[i]?.count ?? 0,
          vip: data.vipPerDay[i]?.count ?? 0,
        }))
      : []),
    [data],
  );

  const kpis = data
    ? [
        { label: t('admin.stats.totalUsers', 'Utilisateurs'), value: data.totals.users, icon: Users, color: 'text-sky-300' },
        { label: t('admin.stats.registrations', 'Inscriptions'), value: data.totals.registrationsInRange, icon: UserPlus, color: 'text-emerald-300' },
        { label: t('admin.stats.logins', 'Connexions'), value: data.totals.sessionsInRange, icon: BarChart3, color: 'text-rose-300' },
        { label: t('admin.stats.avgDau', 'DAU moyen'), value: data.totals.avgDau, icon: Users, color: 'text-purple-300' },
        { label: t('admin.stats.comments', 'Commentaires'), value: data.totals.commentsInRange, icon: MessageSquare, color: 'text-orange-300' },
        { label: t('admin.stats.vip', 'VIP'), value: data.totals.vipInRange, icon: Sparkles, color: 'text-yellow-300' },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                range === r ? 'bg-white/15 text-white' : 'text-white/60 hover:text-white'
              }`}
            >
              {t('admin.stats.lastDays', { count: r, defaultValue: `${r} jours` })}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => load(range)}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-2 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t('admin.stats.refresh', 'Actualiser')}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {loading && !data
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="h-12 animate-pulse rounded bg-white/10" />
              </div>
            ))
          : kpis.map((k) => {
              const Icon = k.icon;
              return (
                <div key={k.label} className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wide text-white/50">{k.label}</span>
                    <Icon className={`h-4 w-4 ${k.color}`} />
                  </div>
                  <div className="mt-2 text-2xl font-bold tabular-nums text-white">{nf.format(k.value)}</div>
                </div>
              );
            })}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <ChartCard title={t('admin.stats.registrationsPerDay', 'Inscriptions par jour')} highlight="16 185 129">
          {data && (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.registrationsPerDay} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="gReg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS.registrations} stopOpacity={0.5} />
                    <stop offset="100%" stopColor={CHART_COLORS.registrations} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDayLabel} stroke={CHART_COLORS.axis} fontSize={11} tickMargin={8} minTickGap={24} />
                <YAxis allowDecimals={false} stroke={CHART_COLORS.axis} fontSize={11} width={32} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={formatDayLabel} />
                <Area type="monotone" dataKey="count" name={t('admin.stats.registrations', 'Inscriptions')} stroke={CHART_COLORS.registrations} strokeWidth={2} fill="url(#gReg)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title={t('admin.stats.loginsVsDau', 'Connexions & DAU')} highlight="244 63 94">
          {data && (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={loginSeries} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDayLabel} stroke={CHART_COLORS.axis} fontSize={11} tickMargin={8} minTickGap={24} />
                <YAxis allowDecimals={false} stroke={CHART_COLORS.axis} fontSize={11} width={32} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={formatDayLabel} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="sessions" name={t('admin.stats.logins', 'Connexions')} stroke={CHART_COLORS.sessions} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="dau" name="DAU" stroke={CHART_COLORS.dau} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title={t('admin.stats.providerSplit', 'Répartition par fournisseur')} highlight="56 189 248">
          {data && (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={providerData} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="80%" paddingAngle={2} stroke="none">
                  {providerData.map((p) => (
                    <Cell key={p.name} fill={PROVIDER_COLORS[p.name] || PROVIDER_COLORS.unknown} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title={t('admin.stats.engagement', 'Engagement par jour')} highlight="249 115 22">
          {data && (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={engagementSeries} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDayLabel} stroke={CHART_COLORS.axis} fontSize={11} tickMargin={8} minTickGap={24} />
                <YAxis allowDecimals={false} stroke={CHART_COLORS.axis} fontSize={11} width={32} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={formatDayLabel} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="comments" name={t('admin.stats.comments', 'Commentaires')} fill={CHART_COLORS.comments} radius={[3, 3, 0, 0]} />
                <Bar dataKey="lists" name={t('admin.stats.lists', 'Listes')} fill={CHART_COLORS.lists} radius={[3, 3, 0, 0]} />
                <Bar dataKey="vip" name="VIP" fill={CHART_COLORS.vip} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>
    </div>
  );
};

export default AdminStats;
