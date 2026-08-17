import { RecordingMeta, SnoreAnalysis } from '@/utils/storage';

export type TrendRange = 'week' | 'month';

export const TREND_DAYS: Record<TrendRange, number> = {
  week: 7,
  month: 30,
};

export interface NightPoint {
  /** Local calendar date key YYYY-MM-DD of the sleep night */
  dateKey: string;
  /** Local midnight of that sleep night */
  date: Date;
  recordingId: string | null;
  snoreDurationSec: number;
  snoreCount: number;
  severity: SnoreAnalysis['severity'] | 'unknown' | null;
  hasRecording: boolean;
  hasAnalysis: boolean;
}

export interface TrendSummary {
  recordedNights: number;
  avgSnoreDurationSec: number;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * Sleep night from recording start, not stop time.
 * Starts before noon belong to the previous calendar day so a 1am
 * session still counts as last night rather than a new day.
 */
export function sleepNightFromStart(startMs: number): Date {
  const start = new Date(startMs);
  const day = startOfLocalDay(start);
  if (start.getHours() < 12) {
    return addDays(day, -1);
  }
  return day;
}

export function getSleepNightDate(meta: RecordingMeta): Date {
  return sleepNightFromStart(meta.createdAt - meta.duration);
}

export function getSleepNightKey(meta: RecordingMeta): string {
  return toDateKey(getSleepNightDate(meta));
}

/** Latest sleep night that "now" could belong to. */
export function getTrendAnchorDate(now: Date = new Date()): Date {
  return sleepNightFromStart(now.getTime());
}

/**
 * One recording per sleep night: the longest session, so a restarted
 * recording does not double-count snore time.
 */
export function pickNightRecordings(recordings: RecordingMeta[]): Map<string, RecordingMeta> {
  const byNight = new Map<string, RecordingMeta>();
  for (const rec of recordings) {
    const key = getSleepNightKey(rec);
    const existing = byNight.get(key);
    if (!existing || rec.duration > existing.duration) {
      byNight.set(key, rec);
    }
  }
  return byNight;
}

export function buildTrendSeries(
  recordings: RecordingMeta[],
  range: TrendRange,
  now: Date = new Date()
): NightPoint[] {
  const days = TREND_DAYS[range];
  const end = getTrendAnchorDate(now);
  const start = addDays(end, -(days - 1));
  const byNight = pickNightRecordings(recordings);

  const points: NightPoint[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const dateKey = toDateKey(date);
    const rec = byNight.get(dateKey);
    if (!rec) {
      points.push({
        dateKey,
        date,
        recordingId: null,
        snoreDurationSec: 0,
        snoreCount: 0,
        severity: null,
        hasRecording: false,
        hasAnalysis: false,
      });
      continue;
    }
    const analysis = rec.analysis;
    points.push({
      dateKey,
      date,
      recordingId: rec.id,
      snoreDurationSec: analysis?.snoreDuration ?? 0,
      snoreCount: analysis?.snoreCount ?? 0,
      severity: analysis ? analysis.severity : 'unknown',
      hasRecording: true,
      hasAnalysis: !!analysis,
    });
  }
  return points;
}

export function summarizeTrend(points: NightPoint[]): TrendSummary {
  const recorded = points.filter((p) => p.hasRecording);
  const analyzed = points.filter((p) => p.hasAnalysis);
  const avgDur = analyzed.length
    ? analyzed.reduce((sum, p) => sum + p.snoreDurationSec, 0) / analyzed.length
    : 0;
  return {
    recordedNights: recorded.length,
    avgSnoreDurationSec: avgDur,
  };
}

export function shouldShowMonthAxisLabel(index: number, length: number): boolean {
  if (index === 0 || index === length - 1) return true;
  return index === Math.floor((length - 1) / 2);
}
