import { useCallback, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Alert,
  Animated,
  Linking,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import { AudioModule } from 'expo-audio';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { LiveWaveform } from '@/components/decibel-chart';
import { RecordingTipsModal } from '@/components/recording-tips-modal';
import { Ionicons } from '@expo/vector-icons';
import { useRecording } from '@/hooks/use-recording';
import { useTheme } from '@/hooks/use-theme';
import { Palette, Spacing, Radius, FontSize } from '@/constants/theme';
import i18n, { getCurrentLanguage } from '@/i18n';
import {
  Recording as RecordingData,
  RecordingMeta,
  getRecordingsMeta,
  saveRecording,
  deleteRecording,
  formatDuration,
  formatDate,
  migrateRecordingsToAuto,
  SNORE_THRESHOLD_DB,
} from '@/utils/storage';
import { analyzeSnoringAuto } from '@/utils/snore-detection';
import { getSeverityColor } from '@/utils/severity';
import { SnoreTrendChart } from '@/components/snore-trend-chart';

export default function HomeScreen() {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [isTipsModalVisible, setIsTipsModalVisible] = useState(false);
  const [isTipsDismissible, setIsTipsDismissible] = useState(false);
  const [currentLanguage, setCurrentLanguage] = useState(getCurrentLanguage());

  const {
    isRecording,
    currentDecibel,
    decibelData,
    duration,
    isLikelySnoring,
    startRecording,
    stopRecording,
    error,
  } = useRecording();
  
  const router = useRouter();
  const { colors, shadow } = useTheme();
  const insets = useSafeAreaInsets();

  // 防止批量迁移重复运行
  const migratingRef = useRef(false);

  const loadRecordings = useCallback(async () => {
    const data = await getRecordingsMeta();
    setRecordings(data);
  }, []);

  // 后台把旧录音（阈值分析/无分析）迁移为自动识别结果，标签渐进刷新
  const runAutoMigration = useCallback(async () => {
    if (migratingRef.current) return;
    migratingRef.current = true;
    try {
      await migrateRecordingsToAuto((metas) => setRecordings(metas));
    } finally {
      migratingRef.current = false;
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      const lang = getCurrentLanguage();
      if (lang !== currentLanguage) {
        setCurrentLanguage(lang);
      }
      // 列表加载后再在后台跑迁移，不阻塞首屏
      loadRecordings().then(runAutoMigration);
    }, [loadRecordings, runAutoMigration, currentLanguage])
  );

  const handleStartRecording = async () => {
    const { granted, canAskAgain } = await AudioModule.getRecordingPermissionsAsync();

    // 权限被拒且系统不会再弹授权框（iOS 拒绝过一次即如此）：
    // 再走提示弹窗只会点"继续"没反应，直接引导去设置开权限
    if (!granted && !canAskAgain) {
      Alert.alert(
        i18n.t('home.micPermissionTitle'),
        i18n.t('home.micPermissionMessage'),
        [
          { text: i18n.t('home.cancel'), style: 'cancel' },
          { text: i18n.t('home.openSettings'), onPress: () => Linking.openSettings() },
        ]
      );
      return;
    }

    // 权限未授予时，提示弹窗必须不可关闭（无 X），点"继续"直达系统权限弹窗；
    // 已授予后弹窗只是使用建议，恢复可关闭。见 RecordingTipsModal 的注释
    setIsTipsDismissible(granted);
    setIsTipsModalVisible(true);
  };

  const handleConfirmStartRecording = async () => {
    await startRecording();
  };

  const handleStopRecording = async () => {
    try {
      const result = await stopRecording();
      
      if (result && result.uri) {
        // 时长必须用 stopRecording 的返回值（按墙钟计算）。
        // 不能用 hook 的 duration state：息屏/后台期间它不更新，
        // 整夜录音时还停留在锁屏前的值，曾导致 9 小时录音只存了 30 秒
        const recordingDuration = result.duration;
        
        // 生成唯一的录音 ID
        const recordingId = Date.now().toString(36) + Math.random().toString(36).substr(2);
        
        // 创建唯一的文件名（相对路径）
        const fileName = `recording_${Date.now()}_${recordingId}.m4a`;
        
        // 复制文件到 document 目录（持久化存储）
        const sourceFile = new File(result.uri);
        const destFile = new File(Paths.document, fileName);
        
        // 确保源文件存在
        if (!sourceFile.exists) {
          throw new Error('录音文件不存在');
        }
        
        // 复制文件
        sourceFile.copy(destFile);
        
        // 验证文件是否真的复制成功
        if (!destFile.exists) {
          throw new Error('文件保存失败');
        }
        
        // 自动识别打鼾（优先用高频数据，精度更高）
        // 分析失败不能拖垮保存：录音先落盘（显示"待分析"），详情页打开时会自动补算
        const analysisSource = result.fullRateData.length > 0 ? result.fullRateData : result.decibelData;
        let analysis: RecordingData['analysis'];
        try {
          analysis = analyzeSnoringAuto(analysisSource, recordingDuration);
        } catch (e) {
          analysis = undefined;
        }

        // 保存录音元数据（使用相对路径）
        const newRecording: RecordingData = {
          id: recordingId,
          uri: fileName, // 只保存文件名（相对路径）
          createdAt: Date.now(),
          duration: recordingDuration > 0 ? recordingDuration : 1000,
          decibelData: result.decibelData,
          analysis,
        };

        // 高频数据一并落盘（二进制文件，~113KB/晚），供将来算法升级后重新分析
        await saveRecording(newRecording, result.fullRateData);
        await loadRecordings();
      } else {
        Alert.alert(i18n.t('home.recordingInProgress'), i18n.t('home.emptyData'));
      }
    } catch (err) {
      Alert.alert(i18n.t('home.saveError'), (err as Error).message);
    }
  };

  const handleDelete = (id: string) => {
    Alert.alert(i18n.t('home.deleteConfirmTitle'), i18n.t('home.deleteConfirmMessage'), [
      { text: i18n.t('home.cancel'), style: 'cancel' },
      {
        text: i18n.t('home.delete'),
        style: 'destructive',
        onPress: async () => {
          await deleteRecording(id);
          await loadRecordings();
        },
      },
    ]);
  };

  // 直接删除（用于滑动删除，不需要确认）
  const handleDirectDelete = async (id: string) => {
    await deleteRecording(id);
    await loadRecordings();
  };

  const handleNightPress = useCallback((recordingId: string) => {
    if (isRecording) {
      Alert.alert(i18n.t('home.recordingInProgress'), i18n.t('home.viewDetailsHint'));
      return;
    }
    router.push(`/recording/${recordingId}` as any);
  }, [isRecording, router]);

  // 渲染滑动删除按钮
  const renderRightActions = (
    progress: Animated.AnimatedInterpolation<number>,
    dragX: Animated.AnimatedInterpolation<number>,
    itemId: string
  ) => {
    const scale = dragX.interpolate({
      inputRange: [-100, 0],
      outputRange: [1, 0.5],
      extrapolate: 'clamp',
    });

    return (
      <TouchableOpacity
        style={[styles.deleteAction, { backgroundColor: colors.danger }]}
        onPress={() => handleDirectDelete(itemId)}
        accessibilityLabel={i18n.t('home.delete')}
        accessibilityRole="button"
      >
        <Animated.View style={{ transform: [{ scale }] }}>
          <ThemedText style={styles.deleteActionText}>{i18n.t('home.delete')}</ThemedText>
        </Animated.View>
      </TouchableOpacity>
    );
  };

  const renderRecordingItem = ({ item }: { item: RecordingMeta }) => (
    <Swipeable
      renderRightActions={(progress, dragX) => renderRightActions(progress, dragX, item.id)}
      rightThreshold={40}
    >
      <TouchableOpacity
        style={[
          styles.recordingItem,
          { backgroundColor: colors.surface, borderColor: colors.border },
          shadow,
        ]}
        onPress={() => {
          if (isRecording) {
            Alert.alert(i18n.t('home.recordingInProgress'), i18n.t('home.viewDetailsHint'));
            return;
          }
          router.push(`/recording/${item.id}` as any);
        }}
        onLongPress={() => handleDelete(item.id)}
        activeOpacity={0.7}
      >
        <View style={styles.recordingInfo}>
          {/* createdAt 是停止录音的时刻，减去时长得到开始录制（入睡）的时间 */}
          <ThemedText style={styles.recordingDate}>{formatDate(item.createdAt - item.duration)}</ThemedText>
          <ThemedText style={[styles.recordingDuration, { color: colors.textMuted }]}>
            {formatDuration(item.duration)}
          </ThemedText>
        </View>
        {item.analysis ? (
          <View style={styles.snoreStat}>
            <ThemedText style={[styles.snoreStatValue, { color: getSeverityColor(item.analysis.severity, colors) }]}>
              {item.analysis.snoreCount}
            </ThemedText>
            <ThemedText style={[styles.snoreStatLabel, { color: colors.textFaint }]}>
              {i18n.t('home.snoresUnit')}
            </ThemedText>
          </View>
        ) : (
          <View style={[styles.analysisTag, { backgroundColor: colors.surfaceSunken }]}>
            <ThemedText style={[styles.analysisTagText, { color: colors.textFaint }]}>{i18n.t('analysis.pending')}</ThemedText>
          </View>
        )}
        <Ionicons name="chevron-forward" size={18} color={colors.textFaint} style={styles.itemChevron} />
      </TouchableOpacity>
    </Swipeable>
  );

  return (
    <ThemedView style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <ThemedText style={styles.title}>{i18n.t('home.title')}</ThemedText>
          <ThemedText style={[styles.subtitle, { color: colors.textMuted }]}>
            {i18n.t('home.subtitle')}
          </ThemedText>
        </View>
        <TouchableOpacity
          onPress={() => router.push('/settings')}
          style={[styles.settingsButton, { backgroundColor: colors.surfaceSunken }]}
          activeOpacity={0.7}
          accessibilityLabel={i18n.t('settings.title')}
          accessibilityRole="button"
        >
          <Ionicons
            name="settings-outline"
            size={22}
            color={colors.textMuted}
          />
        </TouchableOpacity>
      </View>

      {isRecording && (
        <View style={[styles.recordingStatus, { backgroundColor: colors.surface, borderColor: colors.border }, shadow]}>
          {/* 实时分贝显示 */}
          <View style={styles.decibelDisplay}>
            <View style={styles.decibelHeader}>
              <View style={[styles.recordingDot, { backgroundColor: isLikelySnoring ? colors.danger : Palette.success }]} />
              <ThemedText style={[styles.recordingTimeText, { color: colors.textMuted }]}>
                {formatDuration(duration)}
              </ThemedText>
            </View>

            <View style={styles.decibelValueContainer}>
              <ThemedText style={[styles.decibelValue, { color: isLikelySnoring ? colors.danger : colors.brand }]}>
                {Math.round(currentDecibel)}
              </ThemedText>
              <ThemedText style={[styles.decibelUnit, { color: colors.textFaint }]}>dB</ThemedText>
            </View>

            <View style={[styles.snoringAlert, { backgroundColor: colors.danger + '1F', opacity: isLikelySnoring ? 1 : 0 }]}>
              <ThemedText style={[styles.snoringAlertText, { color: colors.danger }]}>{i18n.t('home.snoreDetected')}</ThemedText>
            </View>
          </View>

          {/* 实时波形图 */}
          <View style={styles.waveformContainer}>
            <LiveWaveform recentData={decibelData} height={50} threshold={SNORE_THRESHOLD_DB} />
          </View>
        </View>
      )}

      {error && (
        <View style={[styles.errorContainer, { backgroundColor: colors.danger + '1A' }]}>
          <ThemedText style={[styles.errorText, { color: colors.danger }]}>{error}</ThemedText>
        </View>
      )}

      <FlatList
        data={recordings}
        renderItem={renderRecordingItem}
        keyExtractor={(item) => item.id}
        style={isRecording && styles.listDimmed}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          recordings.length > 0 ? (
            <SnoreTrendChart recordings={recordings} onNightPress={handleNightPress} />
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <View style={[styles.emptyIcon, { backgroundColor: colors.brandSoft }]}>
              <Ionicons name="moon-outline" size={30} color={colors.brand} />
            </View>
            <ThemedText style={styles.emptyText}>
              {i18n.t('home.emptyTitle')}
            </ThemedText>
            <ThemedText style={[styles.emptySubtext, { color: colors.textFaint }]}>
              {i18n.t('home.emptySubtitle')}
            </ThemedText>
          </View>
        }
      />

      <View style={[styles.buttonContainer, { paddingBottom: insets.bottom + 20 }]}>
        <TouchableOpacity
          style={[
            styles.recordButton,
            {
              backgroundColor: isRecording ? colors.danger : colors.brand,
              shadowColor: isRecording ? colors.danger : colors.brand,
            },
          ]}
          onPress={isRecording ? handleStopRecording : handleStartRecording}
          activeOpacity={0.85}
          accessibilityLabel={isRecording ? i18n.t('home.stopRecording') : i18n.t('home.startRecording')}
          accessibilityRole="button"
        >
          {isRecording ? (
            <Ionicons name="stop" size={30} color="#FFFFFF" />
          ) : (
            <Ionicons name="mic" size={32} color="#FFFFFF" />
          )}
        </TouchableOpacity>
        <ThemedText style={[styles.buttonLabel, { color: colors.textMuted }]}>
          {isRecording ? i18n.t('home.stopRecording') : i18n.t('home.startRecording')}
        </ThemedText>
      </View>

      {/* 录音提示弹窗 */}
      <RecordingTipsModal
        key={currentLanguage}
        visible={isTipsModalVisible}
        dismissible={isTipsDismissible}
        onClose={() => setIsTipsModalVisible(false)}
        onStartRecording={handleConfirmStartRecording}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.xl,
  },
  headerLeft: {
    flex: 1,
  },
  settingsButton: {
    width: 40,
    height: 40,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: FontSize.display,
    lineHeight: FontSize.display + 8,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: FontSize.md,
    marginTop: Spacing.xs,
  },
  recordingStatus: {
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Spacing.xl,
    overflow: 'hidden',
  },
  decibelDisplay: {
    alignItems: 'center',
  },
  decibelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: Spacing.sm,
  },
  recordingTimeText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  decibelValueContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  decibelValue: {
    fontSize: 52,
    fontWeight: '800',
    lineHeight: 58,
    letterSpacing: -1,
  },
  decibelUnit: {
    fontSize: FontSize.lg,
    fontWeight: '600',
    marginBottom: 10,
    marginLeft: Spacing.xs,
  },
  snoringAlert: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.pill,
    marginTop: Spacing.sm,
  },
  snoringAlertText: {
    fontSize: FontSize.xs,
    fontWeight: '700',
  },
  waveformContainer: {
    marginVertical: Spacing.md,
    overflow: 'hidden',
    borderRadius: Radius.sm,
  },
  errorContainer: {
    marginHorizontal: Spacing.xl,
    padding: Spacing.md,
    borderRadius: Radius.sm,
    marginBottom: Spacing.sm,
  },
  errorText: {
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
  listContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 200,
  },
  // 录音时压暗下方列表/空状态，让注意力集中在录音卡和停止按钮
  listDimmed: {
    opacity: 0.4,
  },
  recordingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    borderRadius: Radius.md,
    borderWidth: 1,
    marginBottom: Spacing.md,
  },
  recordingInfo: {
    flex: 1,
  },
  recordingDate: {
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
  recordingDuration: {
    fontSize: FontSize.sm,
    marginTop: 3,
  },
  analysisTag: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 5,
    borderRadius: Radius.pill,
  },
  analysisTagText: {
    fontSize: FontSize.xs,
    fontWeight: '700',
  },
  snoreStat: {
    alignItems: 'center',
    minWidth: 44,
  },
  snoreStatValue: {
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  snoreStatLabel: {
    fontSize: 10,
    marginTop: -1,
  },
  itemChevron: {
    marginLeft: Spacing.sm,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 80,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  emptyText: {
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
  emptySubtext: {
    fontSize: FontSize.sm,
    marginTop: Spacing.sm,
    textAlign: 'center',
    paddingHorizontal: Spacing.xl,
  },
  buttonContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingTop: Spacing.xl,
    backgroundColor: 'transparent',
  },
  recordButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 12,
  },
  buttonLabel: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    marginTop: Spacing.md,
  },
  deleteAction: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    borderRadius: Radius.md,
    marginBottom: Spacing.md,
  },
  deleteActionText: {
    color: '#FFFFFF',
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
});
