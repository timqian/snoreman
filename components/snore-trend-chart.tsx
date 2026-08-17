import { useMemo, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { Spacing, Radius, FontSize } from '@/constants/theme';
import i18n, { getDateLocale } from '@/i18n';
import { RecordingMeta, formatDuration } from '@/utils/storage';
import { getSeverityColor } from '@/utils/severity';
import {
  NightPoint,
  TrendRange,
  buildTrendSeries,
  summarizeTrend,
  shouldShowMonthAxisLabel,
} from '@/utils/trend';

const CHART_HEIGHT = 84;
const GAP_TICK = 3;
const RECORDED_MIN = 6;
const SCALE_FLOOR_SEC = 5 * 60;

interface SnoreTrendChartProps {
  recordings: RecordingMeta[];
  onNightPress: (recordingId: string) => void;
}

export function SnoreTrendChart({ recordings, onNightPress }: SnoreTrendChartProps) {
  const { colors, shadow } = useTheme();
  const [range, setRange] = useState<TrendRange>('week');
  const locale = getDateLocale();

  const points = useMemo(
    () => buildTrendSeries(recordings, range),
    [recordings, range]
  );
  const summary = useMemo(() => summarizeTrend(points), [points]);

  const scaleMax = useMemo(() => {
    const maxSnore = points.reduce((m, p) => Math.max(m, p.snoreDurationSec), 0);
    return Math.max(maxSnore, SCALE_FLOOR_SEC);
  }, [points]);

  const barWidthPercent = range === 'week' ? '56%' : '78%';
  const barRadius = range === 'week' ? 4 : 2;

  const axisLabel = (point: NightPoint, index: number): string => {
    if (range === 'week') {
      return point.date.toLocaleDateString(locale, { weekday: 'narrow' });
    }
    if (!shouldShowMonthAxisLabel(index, points.length)) return '';
    return String(point.date.getDate());
  };

  const barHeight = (point: NightPoint): number => {
    if (!point.hasRecording) return GAP_TICK;
    if (point.snoreDurationSec <= 0) return RECORDED_MIN;
    return Math.max(
      RECORDED_MIN,
      RECORDED_MIN + (point.snoreDurationSec / scaleMax) * (CHART_HEIGHT - RECORDED_MIN)
    );
  };

  const barColor = (point: NightPoint): string => {
    if (!point.hasRecording) return colors.border;
    if (!point.hasAnalysis || !point.severity) return colors.severity.unknown;
    return getSeverityColor(point.severity, colors);
  };

  const accessibilityLabel = (point: NightPoint): string => {
    const date = point.date.toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
    });
    if (!point.hasRecording) {
      return i18n.t('trend.gapA11y', { date });
    }
    if (!point.hasAnalysis) {
      return i18n.t('trend.pendingA11y', { date });
    }
    return i18n.t('trend.barA11y', {
      date,
      time: formatDuration(point.snoreDurationSec * 1000),
      count: point.snoreCount,
    });
  };

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.border },
        shadow,
      ]}
    >
      <View style={styles.header}>
        <ThemedText style={styles.title}>{i18n.t('trend.title')}</ThemedText>
        <View style={[styles.toggle, { backgroundColor: colors.surfaceSunken }]}>
          {(['week', 'month'] as TrendRange[]).map((option) => {
            const selected = range === option;
            return (
              <TouchableOpacity
                key={option}
                style={[
                  styles.toggleButton,
                  selected && { backgroundColor: colors.surface },
                  selected && shadow,
                ]}
                onPress={() => setRange(option)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={i18n.t(option === 'week' ? 'trend.week' : 'trend.month')}
              >
                <ThemedText
                  style={[
                    styles.toggleText,
                    { color: selected ? colors.brand : colors.textMuted },
                  ]}
                >
                  {i18n.t(option === 'week' ? 'trend.week' : 'trend.month')}
                </ThemedText>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {summary.recordedNights > 0 ? (
        <ThemedText style={[styles.summary, { color: colors.textMuted }]}>
          {i18n.t('trend.avgSnoreTime', {
            time: formatDuration(summary.avgSnoreDurationSec * 1000),
          })}
          {' · '}
          {summary.recordedNights === 1
            ? i18n.t('trend.nightsRecordedOne')
            : i18n.t('trend.nightsRecorded', { count: summary.recordedNights })}
        </ThemedText>
      ) : (
        <ThemedText style={[styles.summary, { color: colors.textMuted }]}>
          {i18n.t('trend.emptyPeriod')}
        </ThemedText>
      )}

      <View style={[styles.chartWell, { backgroundColor: colors.surfaceSunken }]}>
        <View style={styles.chartBody}>
          <View style={[styles.baseline, { backgroundColor: colors.border }]} />
          <View style={styles.barsRow}>
            {points.map((point) => {
              const height = barHeight(point);
              const disabled = !point.recordingId;
              return (
                <TouchableOpacity
                  key={point.dateKey}
                  style={styles.barHit}
                  onPress={() => {
                    if (point.recordingId) onNightPress(point.recordingId);
                  }}
                  disabled={disabled}
                  activeOpacity={disabled ? 1 : 0.7}
                  accessibilityRole="button"
                  accessibilityState={{ disabled }}
                  accessibilityLabel={accessibilityLabel(point)}
                >
                  <View
                    style={[
                      styles.bar,
                      {
                        width: barWidthPercent,
                        height,
                        borderRadius: barRadius,
                        backgroundColor: barColor(point),
                        opacity: point.hasRecording ? 1 : 0.9,
                      },
                    ]}
                  />
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
        <View style={styles.axisRow}>
          {points.map((point, index) => (
            <View key={point.dateKey} style={styles.axisCell}>
              <ThemedText style={[styles.axisLabel, { color: colors.textFaint }]}>
                {axisLabel(point, index)}
              </ThemedText>
            </View>
          ))}
        </View>
      </View>

      {summary.recordedNights > 0 && summary.recordedNights < 3 && (
        <ThemedText style={[styles.hint, { color: colors.textFaint }]}>
          {i18n.t('trend.sparseHint')}
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  toggle: {
    flexDirection: 'row',
    borderRadius: Radius.sm,
    padding: 3,
  },
  toggleButton: {
    paddingVertical: 5,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.sm - 2,
    alignItems: 'center',
  },
  toggleText: {
    fontSize: FontSize.xs,
    fontWeight: '700',
  },
  summary: {
    fontSize: FontSize.sm,
    marginTop: Spacing.sm,
    marginBottom: Spacing.md,
  },
  chartWell: {
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  chartBody: {
    height: CHART_HEIGHT,
    justifyContent: 'flex-end',
  },
  baseline: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
  },
  barsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: CHART_HEIGHT,
  },
  barHit: {
    flex: 1,
    height: CHART_HEIGHT,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  bar: {},
  axisRow: {
    flexDirection: 'row',
    marginTop: Spacing.xs,
  },
  axisCell: {
    flex: 1,
    alignItems: 'center',
  },
  axisLabel: {
    fontSize: 10,
    fontWeight: '600',
    lineHeight: 14,
  },
  hint: {
    fontSize: FontSize.xs,
    marginTop: Spacing.md,
    textAlign: 'center',
  },
});
