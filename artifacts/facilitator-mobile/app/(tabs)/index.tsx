import React, { useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useConsole } from '@/context/ConsoleContext';
import { TableCard } from '@/components/TableCard';
import { WorkshopFolder } from '@/components/WorkshopFolder';
import { SummaryModal } from '@/components/SummaryModal';
import { CreateSessionSheet, CreateWorkshopSheet } from '@/components/CreateSheet';

type SummaryTarget = { wsId: string; wsName: string; generate: boolean } | null;

export default function GroupsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { state, isConnected, unarchiveTable, deleteTable } = useConsole();

  const [showCreateSession, setShowCreateSession] = useState(false);
  const [showCreateWorkshop, setShowCreateWorkshop] = useState(false);
  const [summaryTarget, setSummaryTarget] = useState<SummaryTarget>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const webTopPad = Platform.OS === 'web' ? 67 : 0;
  const webBottomPad = Platform.OS === 'web' ? 34 : 0;

  // Compute assigned table IDs
  const assignedIds = new Set(state.workshops.flatMap((w) => w.tableIds));
  const unassigned = state.tables.filter((t) => !assignedIds.has(t.id));

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Connection banner */}
      {!isConnected && (
        <View style={[styles.offlineBanner, { backgroundColor: '#fef3c7', borderBottomColor: '#fde68a' }]}>
          <Ionicons name="wifi-outline" size={14} color={colors.amber} />
          <Text style={[styles.offlineText, { color: colors.amber }]}>Reconnecting to server…</Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom: insets.bottom + 24 + webBottomPad,
            paddingTop: webTopPad,
          },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={() => {}} tintColor={colors.primary} />
        }
      >
        {/* Header actions */}
        <View style={styles.headerActions}>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>Discussion Groups</Text>
          <View style={styles.headerBtns}>
            <Pressable
              onPress={() => setShowCreateWorkshop(true)}
              style={[styles.outlineBtn, { borderColor: colors.primary }]}
            >
              <Ionicons name="folder-open-outline" size={14} color={colors.primary} />
              <Text style={[styles.outlineBtnText, { color: colors.primary }]}>Workshop</Text>
            </Pressable>
            <Pressable
              onPress={() => setShowCreateSession(true)}
              style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
            >
              <Ionicons name="add" size={16} color={colors.primaryForeground} />
              <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>New Group</Text>
            </Pressable>
          </View>
        </View>

        {/* Workshop folders */}
        {state.workshops.map((w) => {
          const wTables = state.tables.filter((t) => w.tableIds.includes(t.id));
          return (
            <WorkshopFolderWrapped
              key={w.id}
              workshop={w}
              tables={wTables}
              allWorkshops={state.workshops}
              onCreateSummary={(wsId, wsName) =>
                setSummaryTarget({ wsId, wsName, generate: true })
              }
              onViewSummary={(wsId, wsName) =>
                setSummaryTarget({ wsId, wsName, generate: false })
              }
            />
          );
        })}

        {/* Unassigned tables */}
        {unassigned.length > 0 && (
          <>
            {state.workshops.length > 0 && (
              <View style={[styles.dividerLabel, { borderTopColor: colors.border }]}>
                <Text style={[styles.dividerText, { color: colors.mutedForeground }]}>Unassigned</Text>
              </View>
            )}
            {unassigned.map((t) => (
              <TableCard key={t.id} table={t} workshops={state.workshops} />
            ))}
          </>
        )}

        {/* Waiting sessions */}
        {state.waitingSessions.length > 0 && (
          <>
            <View style={styles.sectionRow}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>Waiting for Pod</Text>
            </View>
            {state.waitingSessions.map((s) => (
              <WaitingCard key={s.tableId} session={s} />
            ))}
          </>
        )}

        {/* Empty state */}
        {state.tables.length === 0 &&
          state.waitingSessions.length === 0 &&
          state.workshops.length === 0 && (
            <View style={styles.emptyState}>
              <Ionicons name="layers-outline" size={52} color={colors.border} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No groups yet</Text>
              <Text style={[styles.emptyBody, { color: colors.mutedForeground }]}>
                Create a discussion group and share the pod link with participants
              </Text>
              <Pressable
                onPress={() => setShowCreateSession(true)}
                style={[styles.emptyBtn, { backgroundColor: colors.primary }]}
              >
                <Ionicons name="add" size={18} color={colors.primaryForeground} />
                <Text style={[styles.emptyBtnText, { color: colors.primaryForeground }]}>
                  Create First Group
                </Text>
              </Pressable>
            </View>
          )}

        {/* Archived section */}
        {state.archivedTables.length > 0 && (
          <View style={[styles.archivedSection, { borderTopColor: colors.border }]}>
            <Pressable
              style={styles.archivedToggle}
              onPress={() => setArchivedOpen((v) => !v)}
            >
              <Ionicons
                name={archivedOpen ? 'chevron-down' : 'chevron-forward'}
                size={12}
                color={colors.mutedForeground}
              />
              <Text style={[styles.archivedToggleText, { color: colors.mutedForeground }]}>
                Archived
              </Text>
              <View style={[styles.archivedBadge, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                <Text style={[styles.archivedBadgeText, { color: colors.mutedForeground }]}>
                  {state.archivedTables.length}
                </Text>
              </View>
            </Pressable>

            {archivedOpen &&
              state.archivedTables.map((a) => (
                <View
                  key={a.id}
                  style={[styles.archivedCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  <View style={styles.archivedCardMain}>
                    <Text style={[styles.archivedName, { color: colors.foreground }]} numberOfLines={1}>
                      {a.name}
                    </Text>
                    <Text style={[styles.archivedSummary, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {a.summary || 'No summary'}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => unarchiveTable(a.id)}
                    style={[styles.restoreBtn, { borderColor: colors.border }]}
                  >
                    <Ionicons name="arrow-undo-outline" size={14} color={colors.mutedForeground} />
                  </Pressable>
                  <Pressable
                    onPress={() =>
                      Alert.alert('Delete permanently?', `This cannot be undone.`, [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Delete', style: 'destructive', onPress: () => deleteTable(a.id) },
                      ])
                    }
                    style={styles.deleteBtn}
                  >
                    <Ionicons name="trash-outline" size={14} color={colors.mutedForeground} />
                  </Pressable>
                </View>
              ))}
          </View>
        )}
      </ScrollView>

      {/* Modals */}
      <CreateSessionSheet
        visible={showCreateSession}
        onClose={() => setShowCreateSession(false)}
      />
      <CreateWorkshopSheet
        visible={showCreateWorkshop}
        onClose={() => setShowCreateWorkshop(false)}
      />
      {summaryTarget && (
        <SummaryModal
          visible
          wsId={summaryTarget.wsId}
          wsName={summaryTarget.wsName}
          generate={summaryTarget.generate}
          onClose={() => setSummaryTarget(null)}
        />
      )}
    </View>
  );
}

// ── WorkshopFolder wrapper with delete ────────────────────────────────────────

function WorkshopFolderWrapped({
  workshop,
  tables,
  allWorkshops,
  onCreateSummary,
  onViewSummary,
}: {
  workshop: import('@/context/ConsoleContext').Workshop;
  tables: import('@/context/ConsoleContext').TableData[];
  allWorkshops: import('@/context/ConsoleContext').Workshop[];
  onCreateSummary: (id: string, name: string) => void;
  onViewSummary: (id: string, name: string) => void;
}) {
  const { deleteWorkshop, renameWorkshop } = useConsole();

  const handleDelete = (wsId: string, wsName: string) => {
    Alert.alert(
      'Delete Workshop',
      `Delete "${wsName}"? Discussions will become unassigned.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteWorkshop(wsId) },
      ],
    );
  };

  return (
    <WorkshopFolder
      workshop={workshop}
      tables={tables}
      allWorkshops={allWorkshops}
      onCreateSummary={onCreateSummary}
      onViewSummary={onViewSummary}
      onDelete={handleDelete}
    />
  );
}

// ── Waiting session card ──────────────────────────────────────────────────────

function WaitingCard({ session }: { session: import('@/context/ConsoleContext').WaitingSession }) {
  const colors = useColors();
  const { deleteTable } = useConsole();

  const handleShare = async () => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const url = `https://${process.env.EXPO_PUBLIC_DOMAIN}/api/pod.html?table=${session.tableId}`;
    try {
      await Share.share({ url, message: url });
    } catch (_) {}
  };

  return (
    <View style={[styles.waitingCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.waitingHeader}>
        <Text style={[styles.waitingName, { color: colors.foreground }]} numberOfLines={1}>
          {session.name}
        </Text>
        <View style={[styles.waitingChip, { backgroundColor: '#fef3c7' }]}>
          <Text style={[styles.waitingChipText, { color: colors.amber }]}>Waiting</Text>
        </View>
        <Text style={[styles.waitingId, { color: colors.mutedForeground }]}>{session.tableId}</Text>
        <Pressable
          onPress={() =>
            Alert.alert('Remove session?', undefined, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Remove', style: 'destructive', onPress: () => deleteTable(session.tableId) },
            ])
          }
          hitSlop={8}
        >
          <Ionicons name="close" size={16} color={colors.mutedForeground} />
        </Pressable>
      </View>
      {session.questions.length > 0 && (
        <View style={styles.waitingQuestions}>
          {session.questions.map((q, i) => (
            <Text key={i} style={[styles.waitingQuestion, { color: colors.foreground }]}>
              · {q}
            </Text>
          ))}
        </View>
      )}
      <View style={[styles.linkRow, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <Ionicons name="link-outline" size={12} color={colors.mutedForeground} />
        <Text style={[styles.linkText, { color: colors.mutedForeground }]} numberOfLines={1}>
          Pod link ready — tap to share
        </Text>
        <Pressable
          onPress={handleShare}
          hitSlop={4}
          style={[styles.shareBtn, { backgroundColor: colors.primary }]}
        >
          <Ionicons name="share-outline" size={13} color={colors.primaryForeground} />
          <Text style={[styles.shareBtnText, { color: colors.primaryForeground }]}>Share</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  offlineText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  content: {
    padding: 16,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  sectionLabel: {
    flex: 1,
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  headerBtns: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  outlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 8,
    borderWidth: 1.5,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  outlineBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  primaryBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  dividerLabel: {
    borderTopWidth: 1,
    borderStyle: 'dashed',
    paddingTop: 10,
    marginBottom: 8,
    marginTop: 4,
  },
  dividerText: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  sectionRow: {
    marginTop: 16,
    marginBottom: 8,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 64,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 20,
    fontFamily: 'Inter_600SemiBold',
  },
  emptyBody: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 32,
  },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 13,
    marginTop: 8,
  },
  emptyBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
  // Archived
  archivedSection: {
    marginTop: 16,
    borderTopWidth: 1,
    borderStyle: 'dashed',
    paddingTop: 10,
  },
  archivedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  archivedToggleText: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  archivedBadge: {
    borderRadius: 100,
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  archivedBadgeText: {
    fontSize: 10,
    fontFamily: 'Inter_500Medium',
  },
  archivedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    marginTop: 6,
    opacity: 0.75,
  },
  archivedCardMain: {
    flex: 1,
    gap: 2,
  },
  archivedName: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  archivedSummary: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
  },
  restoreBtn: {
    borderRadius: 6,
    borderWidth: 1,
    padding: 7,
  },
  deleteBtn: {
    padding: 7,
  },
  // Waiting card
  waitingCard: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    marginBottom: 8,
    gap: 8,
  },
  waitingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  waitingName: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
  waitingChip: {
    borderRadius: 100,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  waitingChipText: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  waitingId: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  waitingQuestions: {
    gap: 2,
  },
  waitingQuestion: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    lineHeight: 19,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  linkText: {
    flex: 1,
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  shareBtnText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
});
