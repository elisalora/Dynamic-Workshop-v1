import React, { useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useConsole } from '@/context/ConsoleContext';
import type { ThemeCandidate } from '@/context/ConsoleContext';

const CONFIDENCE_MAP = {
  high: { label: 'High', bgKey: 'confHighBg' as const, fgKey: 'confHighFg' as const },
  medium: { label: 'Medium', bgKey: 'confMediumBg' as const, fgKey: 'confMediumFg' as const },
  low: { label: 'Low', bgKey: 'confLowBg' as const, fgKey: 'confLowFg' as const },
};

function CandidateCard({ candidate }: { candidate: ThemeCandidate }) {
  const colors = useColors();
  const { sendReveal, sendRevealCustom, sendDismiss } = useConsole();
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState(candidate.topic);

  const conf = CONFIDENCE_MAP[candidate.confidence] ?? CONFIDENCE_MAP.low;

  const handleReveal = () => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    sendReveal(candidate.id);
  };

  const handleRevealCustom = () => {
    if (editText.trim()) {
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      sendRevealCustom(candidate.id, editText.trim());
      setEditMode(false);
    }
  };

  const handleDismiss = () => {
    Alert.alert(
      'Dismiss Theme',
      `Dismiss "${candidate.topic}"? It won't be shown anymore.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Dismiss',
          style: 'destructive',
          onPress: () => sendDismiss(candidate.id),
        },
      ],
    );
  };

  const isRevealed = candidate.state === 'revealed';

  return (
    <View
      style={[
        styles.candidateCard,
        {
          backgroundColor: colors.card,
          borderColor: candidate.confidence === 'high' ? colors.amber : colors.border,
          opacity: isRevealed ? 0.5 : 1,
        },
      ]}
    >
      {/* Header */}
      <View style={styles.candHeader}>
        <Text style={[styles.candTopic, { color: colors.foreground }]} numberOfLines={2}>
          {candidate.topic}
        </Text>
        <View style={[styles.confBadge, { backgroundColor: colors[conf.bgKey] }]}>
          <Text style={[styles.confBadgeText, { color: colors[conf.fgKey] }]}>{conf.label}</Text>
        </View>
      </View>

      {/* Rationale */}
      <Text style={[styles.candRationale, { color: colors.mutedForeground }]}>
        {candidate.rationale}
      </Text>

      {/* Evidence chips */}
      {candidate.evidence.length > 0 && (
        <View style={styles.evidenceRow}>
          {candidate.evidence.map((e, i) => (
            <View key={i} style={[styles.evidenceChip, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              <Text style={[styles.evidenceTable, { color: colors.primary }]}>{e.table}</Text>
              <Text style={[styles.evidenceQuote, { color: colors.foreground }]} numberOfLines={1}>
                {e.quote.slice(0, 55)}…
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Edit input */}
      {editMode && (
        <View style={styles.editRow}>
          <TextInput
            style={[styles.editInput, { backgroundColor: colors.background, borderColor: colors.primary, color: colors.foreground }]}
            value={editText}
            onChangeText={setEditText}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={handleRevealCustom}
          />
        </View>
      )}

      {/* Actions */}
      {!isRevealed ? (
        <View style={styles.candActions}>
          {!editMode ? (
            <>
              <Pressable
                onPress={handleReveal}
                style={[styles.revealBtn, { backgroundColor: colors.primary }]}
              >
                <Ionicons name="radio-outline" size={14} color={colors.primaryForeground} />
                <Text style={[styles.revealBtnText, { color: colors.primaryForeground }]}>
                  Reveal on Board
                </Text>
              </Pressable>
              <Pressable
                onPress={() => { setEditMode(true); setEditText(candidate.topic); }}
                style={[styles.editBtn, { borderColor: colors.border, backgroundColor: colors.muted }]}
              >
                <Ionicons name="pencil-outline" size={14} color={colors.foreground} />
              </Pressable>
              <Pressable
                onPress={handleDismiss}
                style={[styles.dismissBtn, { borderColor: colors.border }]}
              >
                <Ionicons name="close-outline" size={14} color={colors.mutedForeground} />
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                onPress={handleRevealCustom}
                style={[styles.revealBtn, { backgroundColor: colors.primary, flex: 1 }]}
              >
                <Ionicons name="radio-outline" size={14} color={colors.primaryForeground} />
                <Text style={[styles.revealBtnText, { color: colors.primaryForeground }]}>
                  Reveal with Edit
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setEditMode(false)}
                style={[styles.dismissBtn, { borderColor: colors.border }]}
              >
                <Ionicons name="close-outline" size={14} color={colors.mutedForeground} />
              </Pressable>
            </>
          )}
        </View>
      ) : (
        <View style={styles.revealedBadge}>
          <Ionicons name="checkmark-circle" size={14} color={colors.green} />
          <Text style={[styles.revealedText, { color: colors.green }]}>Revealed on board</Text>
        </View>
      )}
    </View>
  );
}

export default function ThemesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { state } = useConsole();

  const active = state.candidates.filter((c) => c.state !== 'dismissed');

  const webTopPad = Platform.OS === 'web' ? 67 : 0;
  const webBottomPad = Platform.OS === 'web' ? 34 : 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 24 + webBottomPad, paddingTop: webTopPad },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Section header */}
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
            Cross-Table Themes
          </Text>
          <View style={[styles.countPill, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Text style={[styles.countPillText, { color: colors.mutedForeground }]}>{active.length}</Text>
          </View>
        </View>

        {active.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="git-merge-outline" size={44} color={colors.border} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No themes yet</Text>
            <Text style={[styles.emptyBody, { color: colors.mutedForeground }]}>
              Cross-table patterns will appear here as discussions progress
            </Text>
          </View>
        ) : (
          active.map((c) => <CandidateCard key={c.id} candidate={c} />)
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  countPill: {
    borderRadius: 100,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countPillText: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
  },
  candidateCard: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
    gap: 10,
  },
  candHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  candTopic: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    lineHeight: 22,
  },
  confBadge: {
    borderRadius: 100,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  confBadgeText: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  candRationale: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    lineHeight: 19,
  },
  evidenceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  evidenceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  evidenceTable: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
  },
  evidenceQuote: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    flexShrink: 1,
  },
  editRow: {
    gap: 6,
  },
  editInput: {
    borderWidth: 1.5,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  candActions: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  revealBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  revealBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  editBtn: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissBtn: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  revealedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  revealedText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 64,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: 'Inter_600SemiBold',
  },
  emptyBody: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 32,
  },
});
