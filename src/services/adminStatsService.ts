import axios from 'axios';
import { MAIN_API } from '../config/runtime';

export type StatPoint = { date: string; count: number };

export interface StatsOverview {
  range: number;
  generatedAt: number;
  totals: {
    users: number;
    byProvider: Record<string, number>;
    registrationsInRange: number;
    sessionsInRange: number;
    avgDau: number;
    commentsInRange: number;
    vipInRange: number;
  };
  registrationsPerDay: StatPoint[];
  sessionsPerDay: StatPoint[];
  dauPerDay: StatPoint[];
  commentsPerDay: StatPoint[];
  sharedListsPerDay: StatPoint[];
  vipPerDay: StatPoint[];
}

export type StatsRange = 7 | 30 | 90;

export async function fetchStatsOverview(range: StatsRange): Promise<StatsOverview> {
  const token = localStorage.getItem('auth_token');
  const res = await axios.get<StatsOverview>(`${MAIN_API}/api/admin/stats/overview`, {
    params: { range },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    timeout: 20000,
  });
  return res.data;
}
