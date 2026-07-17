import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useConsole } from '@/context/ConsoleContext';

interface Props {
  visible: boolean;
  wsId: string;
  wsName: string;
  generate: boolean;
  onClose: () => void;
}

async function copyText(text: string) {
  if (Platform.OS === 'web') {
    try {
      await (navigator as Navigator & { clipboard: Clipboard }).clipboard.writeText(text);
    } catch {
      Alert.alert('Copy failed', 'Could not copy to clipboard.');
    }
  } else {
    await Share.share({ message: text });
  }
}

export function SummaryModal({ visible, wsId, wsName, generate, onClose }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { state, generateSummary } = useConsole();
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const workshop = state.workshops.find((w) => w.id === wsId);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    setCopied(false);

    if (!generate && workshop?.summary) {
      setSummary(workshop.summary);
      setLoading(false);
      return;
    }

    if (generate) {
      setSummary(null);
      setLoading(true);
      generateSummary(wsId)
        .then((text) => {
          setSummary(text);
          setLoading(false);
        })
        .catch((e: Error) => {
          setError(e.message ?? 'Failed to generate summary');
          setLoading(false);
        });
    }
  }, [visible, wsId, generate]);

  const handleCopy = async () => {
    if (!summary) return;
    await copyText(summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRegen = () => {
    setError(null);
    setSummary(null);
    setLoading(true);
    generateSummary(wsId)
      .then((text) => {
        setSummary(text);
        setLoading(false);
      })
      .catch((e: Error) => {
        setError(e.message ?? 'Failed to generate summary');
        setLoading(false);
      });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 12 }]}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <View style={styles.headerText}>
            <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
              {wsName}
            </Text>
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              {loading ? 'Generating summary…' : summary ? 'Workshop summary' : 'No summary'}
            </Text>
          </View>
          <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={10}>
            <Ionicons name="close" size={22} color={colors.mutedForeground} />
          </Pressable>
        </View>

        {/* Body */}
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {loading && (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>
                Scribe is reading all discussions and synthesising a report…
              </Text>
            </View>
          )}

          {error && !loading && (
            <View style={styles.errorContainer}>
              <Ionicons name="alert-circle-outline" size={32} color={colors.destructive} />
              <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
              <Pressable
                onPress={handleRegen}
                style={[styles.retryBtn, { backgroundColor: colors.primary }]}
              >
                <Text style={[styles.retryBtnText, { color: colors.primaryForeground }]}>
                  Try again
                </Text>
              </Pressable>
            </View>
          )}

          {summary && !loading && !error && (
            <MarkdownView text={summary} colors={colors} />
          )}
        </ScrollView>

        {/* Footer */}
        {!loading && summary && (
          <View style={[styles.footer, { borderTopColor: colors.border, paddingBottom: insets.bottom + 12 }]}>
            <Pressable
              onPress={handleRegen}
              style={[styles.footerBtn, { borderColor: colors.border }]}
            >
              <Ionicons name="refresh-outline" size={16} color={colors.mutedForeground} />
              <Text style={[styles.footerBtnText, { color: colors.mutedForeground }]}>Regenerate</Text>
            </Pressable>
            <Pressable
              onPress={handleCopy}
              style={[styles.footerPrimaryBtn, { backgroundColor: colors.primary }]}
            >
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={16}
                color={colors.primaryForeground}
              />
              <Text style={[styles.footerPrimaryBtnText, { color: colors.primaryForeground }]}>
                {copied ? 'Copied!' : 'Copy Markdown'}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  );
}

// ── Minimal markdown renderer ─────────────────────────────────────────────────

interface MarkdownProps {
  text: string;
  colors: ReturnType<typeof useColors>;
}

function MarkdownView({ text, colors }: MarkdownProps) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let key = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      elements.push(<View key={key++} style={{ height: 6 }} />);
    } else if (line.startsWith('## ')) {
      elements.push(
        <Text key={key++} style={[styles.mdH2, { color: colors.primary, borderBottomColor: '#bfdbfe' }]}>
          {stripBold(line.slice(3))}
        </Text>,
      );
    } else if (line.startsWith('### ')) {
      elements.push(
        <Text key={key++} style={[styles.mdH3, { color: colors.foreground }]}>
          {stripBold(line.slice(4))}
        </Text>,
      );
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <View key={key++} style={styles.mdListItem}>
          <Text style={[styles.mdBullet, { color: colors.mutedForeground }]}>•</Text>
          <Text style={[styles.mdBody, { color: colors.foreground, flex: 1 }]}>
            {stripBold(line.slice(2))}
          </Text>
        </View>,
      );
    } else if (line.startsWith('> ')) {
      elements.push(
        <View key={key++} style={[styles.mdBlockquote, { borderLeftColor: colors.border }]}>
          <Text style={[styles.mdBody, { color: colors.mutedForeground, fontStyle: 'italic' }]}>
            {stripBold(line.slice(2))}
          </Text>
        </View>,
      );
    } else {
      elements.push(
        <Text key={key++} style={[styles.mdBody, { color: colors.foreground }]}>
          {stripBold(line)}
        </Text>,
      );
    }
  }

  return <View style={styles.markdown}>{elements}</View>;
}

function stripBold(s: string): string {
  // Remove ** markers (simple inline bold stripping for plain text render)
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  closeBtn: {
    paddingTop: 2,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: 20,
    paddingBottom: 32,
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 48,
    gap: 16,
  },
  loadingText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    fontStyle: 'italic',
    paddingHorizontal: 24,
    lineHeight: 20,
  },
  errorContainer: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 12,
  },
  errorText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
  },
  retryBtn: {
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginTop: 8,
  },
  retryBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  footerBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 12,
  },
  footerBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
  },
  footerPrimaryBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 10,
    paddingVertical: 12,
  },
  footerPrimaryBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  // Markdown styles
  markdown: {
    gap: 4,
  },
  mdH2: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
    marginTop: 16,
    marginBottom: 4,
    paddingBottom: 4,
    borderBottomWidth: 1,
  },
  mdH3: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    marginTop: 10,
    marginBottom: 2,
  },
  mdBody: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    lineHeight: 22,
  },
  mdListItem: {
    flexDirection: 'row',
    gap: 8,
    paddingLeft: 4,
    marginBottom: 2,
  },
  mdBullet: {
    fontSize: 14,
    lineHeight: 22,
    width: 12,
  },
  mdBlockquote: {
    borderLeftWidth: 3,
    paddingLeft: 12,
    marginVertical: 4,
  },
});
