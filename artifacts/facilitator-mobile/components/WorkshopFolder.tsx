import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { Workshop, TableData } from '@/context/ConsoleContext';
import { TableCard } from './TableCard';

interface Props {
  workshop: Workshop;
  tables: TableData[];
  allWorkshops: Workshop[];
  onCreateSummary: (wsId: string, wsName: string) => void;
  onViewSummary: (wsId: string, wsName: string) => void;
  onDelete: (wsId: string, wsName: string) => void;
}

export function WorkshopFolder({
  workshop,
  tables,
  allWorkshops,
  onCreateSummary,
  onViewSummary,
  onDelete,
}: Props) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(true);

  return (
    <View style={[styles.folder, { backgroundColor: colors.card, borderColor: expanded ? '#bfdbfe' : colors.border }]}>
      {/* Folder header */}
      <Pressable
        style={[styles.header, { backgroundColor: expanded ? '#f0f7ff' : colors.muted }]}
        onPress={() => setExpanded((v) => !v)}
      >
        <Ionicons
          name={expanded ? 'chevron-down' : 'chevron-forward'}
          size={14}
          color={colors.mutedForeground}
        />
        <Ionicons name="folder" size={16} color={colors.primary} />
        <Text style={[styles.workshopName, { color: colors.foreground }]} numberOfLines={1}>
          {workshop.name}
        </Text>
        <View style={[styles.countBadge, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Text style={[styles.countText, { color: colors.mutedForeground }]}>
            {tables.length}
          </Text>
        </View>

        <View style={styles.actions}>
          {workshop.summary ? (
            <Pressable
              style={[styles.actionBtn, { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' }]}
              onPress={() => onViewSummary(workshop.id, workshop.name)}
            >
              <Ionicons name="document-text-outline" size={12} color={colors.green} />
              <Text style={[styles.actionBtnText, { color: colors.green }]}>Summary</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.actionBtn, { backgroundColor: colors.secondary, borderColor: '#bfdbfe' }]}
            onPress={() => onCreateSummary(workshop.id, workshop.name)}
          >
            <Ionicons name="sparkles-outline" size={12} color={colors.primary} />
            <Text style={[styles.actionBtnText, { color: colors.primary }]}>
              {workshop.summary ? 'Regen' : 'Summarise'}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.iconBtn]}
            onPress={() => onDelete(workshop.id, workshop.name)}
          >
            <Ionicons name="trash-outline" size={14} color={colors.mutedForeground} />
          </Pressable>
        </View>
      </Pressable>

      {/* Body */}
      {expanded && (
        <View style={[styles.body, { borderTopColor: colors.border }]}>
          {workshop.summary && workshop.summaryGeneratedAt ? (
            <Pressable
              style={[styles.summaryBar, { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' }]}
              onPress={() => onViewSummary(workshop.id, workshop.name)}
            >
              <Ionicons name="checkmark-circle" size={14} color={colors.green} />
              <Text style={[styles.summaryBarText, { color: colors.green }]}>Summary available</Text>
              <Text style={[styles.summaryBarDate, { color: colors.green }]}>
                {formatRelative(workshop.summaryGeneratedAt)}
              </Text>
            </Pressable>
          ) : null}

          {tables.length === 0 ? (
            <View style={styles.emptyBody}>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No discussions assigned yet
              </Text>
            </View>
          ) : (
            <View style={styles.tablesList}>
              {tables.map((t) => (
                <TableCard key={t.id} table={t} workshops={allWorkshops} />
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

const styles = StyleSheet.create({
  folder: {
    borderRadius: 12,
    borderWidth: 1.5,
    overflow: 'hidden',
    marginBottom: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  workshopName: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
  countBadge: {
    borderRadius: 100,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countText: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  actionBtnText: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
  },
  iconBtn: {
    padding: 4,
  },
  body: {
    borderTopWidth: 1,
  },
  summaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    margin: 10,
    marginBottom: 2,
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
  },
  summaryBarText: {
    flex: 1,
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  summaryBarDate: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    opacity: 0.75,
  },
  tablesList: {
    padding: 10,
  },
  emptyBody: {
    padding: 20,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
  },
});
