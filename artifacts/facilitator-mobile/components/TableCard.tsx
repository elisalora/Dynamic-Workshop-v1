import React, { useRef, useState, useCallback } from 'react';
import {
  Alert,
  Animated,
  PanResponder,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Svg, { Rect } from 'react-native-svg';
import { useColors } from '@/hooks/useColors';
import type { TableData, Workshop } from '@/context/ConsoleContext';
import { useConsole } from '@/context/ConsoleContext';

// ── Status chip ───────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const colors = useColors();
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    flowing:    { bg: colors.statusFlowingBg,    fg: colors.statusFlowingFg,    label: 'Flowing' },
    circling:   { bg: colors.statusCirclingBg,   fg: colors.statusCirclingFg,   label: 'Circling' },
    quiet:      { bg: colors.statusQuietBg,      fg: colors.statusQuietFg,      label: 'Quiet' },
    converging: { bg: colors.statusConvergingBg, fg: colors.statusConvergingFg, label: 'Converging' },
  };
  const chip = map[status] ?? map['quiet'];
  return (
    <View style={[styles.chip, { backgroundColor: chip.bg }]}>
      <Text style={[styles.chipText, { color: chip.fg }]}>{chip.label}</Text>
    </View>
  );
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({ history, color }: { history: number[]; color: string }) {
  const bars = 10;
  const recent = history.slice(-bars);
  const padded = Array.from({ length: bars }, (_, i) => recent[i - (bars - recent.length)] ?? 0);
  const maxVal = Math.max(...padded, 1);
  const W = 52;
  const H = 26;
  const barW = W / bars - 1;

  return (
    <Svg width={W} height={H}>
      {padded.map((v, i) => {
        const h = Math.max(2, Math.round((v / maxVal) * (H - 2)));
        return (
          <Rect
            key={i}
            x={i * (barW + 1)}
            y={H - h}
            width={barW}
            height={h}
            rx={1}
            fill={color}
            opacity={0.4}
          />
        );
      })}
    </Svg>
  );
}

// ── Main TableCard ────────────────────────────────────────────────────────────

interface Props {
  table: TableData;
  workshops: Workshop[];
}

const SWIPE_THRESHOLD = 80;

export function TableCard({ table, workshops }: Props) {
  const colors = useColors();
  const { archiveTable, assignTable, unassignTable } = useConsole();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Swipe-to-archive
  const translateX = useRef(new Animated.Value(0)).current;
  const swipeActive = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderGrant: () => { swipeActive.current = true; },
      onPanResponderMove: (_, g) => {
        if (g.dx < 0) translateX.setValue(g.dx);
      },
      onPanResponderRelease: (_, g) => {
        swipeActive.current = false;
        if (g.dx < -SWIPE_THRESHOLD) {
          Animated.spring(translateX, { toValue: -120, useNativeDriver: true }).start();
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => {
        swipeActive.current = false;
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  const handleArchive = () => {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
    Alert.alert(
      'Archive Discussion',
      `Archive "${table.name}"? The data is preserved and can be restored.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: () => archiveTable(table.id),
        },
      ],
    );
  };

  const handleLongPress = () => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    handleArchive();
  };

  const handleAssignWorkshop = () => {
    const current = workshops.find((w) => w.tableIds.includes(table.id));
    Alert.alert(
      'Assign to Workshop',
      current ? `Currently: ${current.name}` : 'Not assigned',
      [
        ...(current
          ? [{ text: 'Unassign', onPress: () => unassignTable(current.id, table.id) }]
          : []),
        ...workshops
          .filter((w) => w.id !== current?.id)
          .map((w) => ({
            text: w.name,
            onPress: () => assignTable(w.id, table.id),
          })),
        { text: 'Cancel', style: 'cancel' as const },
      ],
    );
  };

  const board = table.board ?? { clusters: [], ideas: [], quotes: [], flags: [], synthesis: null };
  const metrics = table.metrics ?? { wpmHistory: [], currentWpm: 0, novelty: 0, status: 'quiet', lastSpeechAt: 0 };
  const currentWs = workshops.find((w) => w.tableIds.includes(table.id));

  const handleShare = async () => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const url = `https://${process.env.EXPO_PUBLIC_DOMAIN}/api/pod.html?table=${table.id}`;
    if (Platform.OS === 'web') {
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch (_) {}
    } else {
      try {
        await Share.share({ url, message: url });
      } catch (_) {}
    }
  };

  return (
    <View style={styles.swipeContainer}>
      {/* Archive button underneath */}
      <View style={[styles.archiveReveal, { backgroundColor: colors.statusCirclingBg }]}>
        <Pressable onPress={handleArchive} style={styles.archiveRevealBtn}>
          <Ionicons name="archive-outline" size={20} color={colors.statusCirclingFg} />
          <Text style={[styles.archiveRevealText, { color: colors.statusCirclingFg }]}>Archive</Text>
        </Pressable>
      </View>

      <Animated.View
        style={{ transform: [{ translateX }] }}
        {...panResponder.panHandlers}
      >
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          onLongPress={handleLongPress}
          delayLongPress={600}
        >
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: expanded ? colors.primary : colors.border }]}>
            {/* Header row */}
            <View style={styles.cardHeader}>
              <Text style={[styles.tableName, { color: colors.foreground }]} numberOfLines={1}>
                {table.name}
              </Text>
              <StatusChip status={metrics.status} />
              <Sparkline history={metrics.wpmHistory} color={colors.primary} />
              <Ionicons
                name={expanded ? 'chevron-up' : 'chevron-down'}
                size={14}
                color={colors.mutedForeground}
              />
            </View>

            {/* Summary preview */}
            {!expanded && (
              <Text style={[styles.summaryPreview, { color: colors.mutedForeground }]} numberOfLines={1}>
                {table.summary || 'No summary yet'}
              </Text>
            )}

            {/* Expanded detail */}
            {expanded && (
              <View style={[styles.detail, { borderTopColor: colors.border }]}>
                {/* Synthesis */}
                {board.synthesis ? (
                  <View style={[styles.section, { backgroundColor: colors.secondary, borderLeftColor: colors.primary }]}>
                    <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Synthesis</Text>
                    <Text style={[styles.synthesisText, { color: colors.foreground }]}>{board.synthesis}</Text>
                  </View>
                ) : null}

                {/* Questions */}
                {table.questions?.length > 0 && (
                  <View style={styles.section}>
                    <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Questions</Text>
                    {table.questions.map((q, i) => (
                      <Text key={i} style={[styles.questionItem, { color: colors.foreground }]}>
                        · {q}
                      </Text>
                    ))}
                  </View>
                )}

                {/* Clusters */}
                <View style={styles.section}>
                  <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Clusters & Ideas</Text>
                  {board.clusters.length === 0 ? (
                    <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No clusters yet</Text>
                  ) : (
                    board.clusters.map((c) => {
                      const ideas = board.ideas.filter((i) => i.clusterId === c.id);
                      return (
                        <View key={c.id} style={styles.clusterBlock}>
                          <Text style={[styles.clusterLabel, { color: colors.primary }]}>{c.label}</Text>
                          {ideas.map((idea) => (
                            <Text key={idea.id} style={[styles.ideaRow, { color: colors.foreground }]}>
                              – {idea.text}
                            </Text>
                          ))}
                        </View>
                      );
                    })
                  )}
                </View>

                {/* Quotes */}
                {board.quotes.length > 0 && (
                  <View style={styles.section}>
                    <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Quotes</Text>
                    {board.quotes.map((q) => (
                      <View key={q.id} style={[styles.quoteRow, { borderLeftColor: colors.border }]}>
                        <Text style={[styles.quoteText, { color: colors.foreground }]}>"{q.text}"</Text>
                      </View>
                    ))}
                  </View>
                )}

                {/* Flags */}
                {board.flags.length > 0 && (
                  <View style={styles.section}>
                    <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Flags</Text>
                    <View style={styles.flagsRow}>
                      {board.flags.map((f) => (
                        <View key={f.id} style={[styles.flagChip, { backgroundColor: colors.muted }]}>
                          <Text style={[styles.flagKind, { color: colors.mutedForeground }]}>
                            {f.kind.replace(/_/g, ' ')}
                          </Text>
                          <Text style={[styles.flagText, { color: colors.foreground }]}>{f.text}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}

                {/* Actions */}
                {Platform.OS === 'web' && (
                  <View style={[styles.urlRow, { backgroundColor: colors.background, borderColor: colors.border }]}>
                    <Ionicons name="link-outline" size={12} color={colors.mutedForeground} />
                    <TextInput
                      value={`https://${process.env.EXPO_PUBLIC_DOMAIN}/api/pod.html?table=${table.id}`}
                      editable={false}
                      selectTextOnFocus
                      style={[styles.urlInput, { color: colors.mutedForeground }]}
                    />
                  </View>
                )}
                <View style={[styles.actionsRow, { borderTopColor: colors.border }]}>
                  <Pressable
                    onPress={handleAssignWorkshop}
                    style={[styles.actionBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
                  >
                    <Ionicons name="folder-outline" size={14} color={colors.mutedForeground} />
                    <Text style={[styles.actionBtnText, { color: colors.mutedForeground }]}>
                      {currentWs ? currentWs.name : 'Assign Workshop'}
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={handleShare}
                    style={[styles.actionBtn, { backgroundColor: copied ? colors.statusFlowingBg : colors.muted, borderColor: colors.border }]}
                  >
                    <Ionicons
                      name={copied ? 'checkmark-outline' : 'share-outline'}
                      size={14}
                      color={copied ? colors.statusFlowingFg : colors.mutedForeground}
                    />
                    <Text style={[styles.actionBtnText, { color: copied ? colors.statusFlowingFg : colors.mutedForeground }]}>
                      {copied ? 'Copied!' : 'Share Pod'}
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={handleArchive}
                    style={[styles.actionBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
                  >
                    <Ionicons name="archive-outline" size={14} color={colors.mutedForeground} />
                    <Text style={[styles.actionBtnText, { color: colors.mutedForeground }]}>Archive</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  swipeContainer: {
    position: 'relative',
    marginBottom: 8,
  },
  archiveReveal: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 120,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  archiveRevealBtn: {
    alignItems: 'center',
    gap: 4,
  },
  archiveRevealText: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  tableName: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
  chip: {
    borderRadius: 100,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipText: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  summaryPreview: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  detail: {
    borderTopWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 14,
    gap: 12,
  },
  section: {
    gap: 4,
  },
  detailLabel: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  synthesisText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    lineHeight: 19,
    borderLeftWidth: 3,
    paddingLeft: 10,
    borderRadius: 4,
  },
  questionItem: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    lineHeight: 20,
  },
  clusterBlock: {
    marginBottom: 6,
  },
  clusterLabel: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 2,
  },
  ideaRow: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    lineHeight: 18,
    paddingLeft: 8,
  },
  quoteRow: {
    borderLeftWidth: 2,
    paddingLeft: 8,
    marginBottom: 4,
  },
  quoteText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
    lineHeight: 18,
  },
  flagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  flagChip: {
    flexDirection: 'row',
    gap: 4,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignItems: 'center',
  },
  flagKind: {
    fontSize: 9,
    fontFamily: 'Inter_700Bold',
    textTransform: 'uppercase',
  },
  flagText: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
    borderTopWidth: 1,
    paddingTop: 12,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 7,
    borderWidth: 1,
  },
  actionBtnText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  emptyText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
  },
  urlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  urlInput: {
    flex: 1,
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    // Remove default browser input chrome on web
    ...(Platform.OS === 'web' ? { outlineWidth: 0, cursor: 'text' } as any : {}),
  },
});
