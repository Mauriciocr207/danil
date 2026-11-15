import { RADIUS } from "@terminus/design";
import { Platform, StyleSheet, Text } from "react-native";
import { useTheme } from "../theme";

/**
 * El texto del diagrama tal cual, cuando no se puede dibujar. Vive aparte de `Mermaid.tsx`
 * porque en web Metro resuelve `./Mermaid` a `Mermaid.web.tsx`, que no lo exporta, y el
 * import quedaba `undefined` y tumbaba la conversación (terminus-workspace#155).
 */
export function CodeFallback({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text selectable style={[styles.mono, { color: theme.text, backgroundColor: theme.muted }]}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  mono: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 12.5, lineHeight: 18, padding: 10, borderRadius: RADIUS.lg },
});
