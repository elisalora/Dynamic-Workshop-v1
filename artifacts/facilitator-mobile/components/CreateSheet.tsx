import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
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

// ── Create Session Sheet ──────────────────────────────────────────────────────

interface CreateSessionProps {
  visible: boolean;
  onClose: () => void;
}

export function CreateSessionSheet({ visible, onClose }: CreateSessionProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { createSession } = useConsole();
  const [name, setName] = useState('');
  const [questions, setQuestions] = useState<string[]>(['']);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setName('');
    setQuestions(['']);
    setLoading(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const addQuestion = () => setQuestions((q) => [...q, '']);
  const removeQuestion = (i: number) =>
    setQuestions((q) => q.filter((_, idx) => idx !== i));
  const updateQuestion = (i: number, v: string) =>
    setQuestions((q) => q.map((qv, idx) => (idx === i ? v : qv)));

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert('Name required', 'Please enter a group name.');
      return;
    }
    setLoading(true);
    try {
      const qs = questions.map((q) => q.trim()).filter(Boolean);
      await createSession(trimmed, qs);
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      handleClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      Alert.alert('Error', `Failed to create group: ${msg}`);
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: colors.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border, paddingTop: insets.top + 16 }]}>
          <Text style={[styles.sheetTitle, { color: colors.foreground }]}>New Discussion Group</Text>
          <Pressable onPress={handleClose} hitSlop={12}>
            <Ionicons name="close" size={22} color={colors.mutedForeground} />
          </Pressable>
        </View>

        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Name */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>Group name</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
              placeholder="e.g. Future of Work, Table 3…"
              placeholderTextColor={colors.mutedForeground}
              value={name}
              onChangeText={setName}
              returnKeyType="next"
              autoFocus
            />
          </View>

          {/* Questions */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>
              Discussion questions{' '}
              <Text style={[styles.labelOptional, { color: colors.mutedForeground }]}>(optional)</Text>
            </Text>
            {questions.map((q, i) => (
              <View key={i} style={styles.questionRow}>
                <TextInput
                  style={[styles.input, styles.questionInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                  placeholder="e.g. What assumptions are we making?"
                  placeholderTextColor={colors.mutedForeground}
                  value={q}
                  onChangeText={(v) => updateQuestion(i, v)}
                  returnKeyType="next"
                />
                {questions.length > 1 && (
                  <Pressable
                    onPress={() => removeQuestion(i)}
                    style={[styles.removeBtn, { borderColor: colors.border }]}
                    hitSlop={6}
                  >
                    <Ionicons name="close" size={14} color={colors.mutedForeground} />
                  </Pressable>
                )}
              </View>
            ))}
            <Pressable
              onPress={addQuestion}
              style={[styles.addQuestionBtn, { borderColor: colors.border }]}
            >
              <Ionicons name="add" size={16} color={colors.mutedForeground} />
              <Text style={[styles.addQuestionText, { color: colors.mutedForeground }]}>Add a question</Text>
            </Pressable>
          </View>
        </ScrollView>

        {/* Footer */}
        <View style={[styles.footer, { borderTopColor: colors.border, paddingBottom: insets.bottom + 16 }]}>
          <Pressable onPress={handleClose} style={[styles.cancelBtn, { borderColor: colors.border }]}>
            <Text style={[styles.cancelBtnText, { color: colors.mutedForeground }]}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handleCreate}
            disabled={loading}
            style={[styles.createBtn, { backgroundColor: loading ? colors.muted : colors.primary }]}
          >
            {loading ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <>
                <Ionicons name="link-outline" size={16} color={colors.primaryForeground} />
                <Text style={[styles.createBtnText, { color: colors.primaryForeground }]}>
                  Create & Generate Link
                </Text>
              </>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Create Workshop Sheet ─────────────────────────────────────────────────────

interface CreateWorkshopProps {
  visible: boolean;
  onClose: () => void;
}

export function CreateWorkshopSheet({ visible, onClose }: CreateWorkshopProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { createWorkshop } = useConsole();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleClose = () => {
    setName('');
    setLoading(false);
    onClose();
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert('Name required', 'Please enter a workshop name.');
      return;
    }
    setLoading(true);
    try {
      await createWorkshop(trimmed);
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      handleClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      Alert.alert('Error', `Failed to create workshop: ${msg}`);
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: colors.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={[styles.header, { borderBottomColor: colors.border, paddingTop: insets.top + 16 }]}>
          <Text style={[styles.sheetTitle, { color: colors.foreground }]}>New Workshop</Text>
          <Pressable onPress={handleClose} hitSlop={12}>
            <Ionicons name="close" size={22} color={colors.mutedForeground} />
          </Pressable>
        </View>

        <View style={styles.body}>
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>Workshop name</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
              placeholder="e.g. Innovation Sprint — Day 1"
              placeholderTextColor={colors.mutedForeground}
              value={name}
              onChangeText={setName}
              returnKeyType="done"
              onSubmitEditing={handleCreate}
              autoFocus
            />
          </View>
        </View>

        <View style={[styles.footer, { borderTopColor: colors.border, paddingBottom: insets.bottom + 16 }]}>
          <Pressable onPress={handleClose} style={[styles.cancelBtn, { borderColor: colors.border }]}>
            <Text style={[styles.cancelBtnText, { color: colors.mutedForeground }]}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handleCreate}
            disabled={loading}
            style={[styles.createBtn, { backgroundColor: loading ? colors.muted : colors.primary }]}
          >
            {loading ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <>
                <Ionicons name="folder-open-outline" size={16} color={colors.primaryForeground} />
                <Text style={[styles.createBtnText, { color: colors.primaryForeground }]}>
                  Create Workshop
                </Text>
              </>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
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
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  sheetTitle: {
    fontSize: 17,
    fontFamily: 'Inter_600SemiBold',
  },
  body: {
    flex: 1,
    padding: 20,
  },
  bodyContent: {
    paddingBottom: 20,
  },
  field: {
    marginBottom: 20,
    gap: 6,
  },
  label: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  labelOptional: {
    fontFamily: 'Inter_400Regular',
    textTransform: 'none',
    letterSpacing: 0,
    fontSize: 11,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  questionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  questionInput: {
    flex: 1,
  },
  removeBtn: {
    width: 30,
    height: 30,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addQuestionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    marginTop: 2,
  },
  addQuestionText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  cancelBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 13,
  },
  cancelBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  createBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 13,
  },
  createBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
});
