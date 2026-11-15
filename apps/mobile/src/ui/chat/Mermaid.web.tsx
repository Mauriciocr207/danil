import { useTheme } from "../theme";
import { Component, type ReactNode, useEffect, useState } from "react";
import { View } from "react-native";
import { CodeFallback } from "./CodeFallback";

let seq = 0;

/**
 * En el navegador, mermaid corre en la página como en la ventana (`ui/Mermaid.tsx`),
 * cargado al primer diagrama: la política de la página no deja traerlo de afuera.
 */
function Diagram({ definition }: { definition: string }) {
  const dark = useTheme().dark;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: dark ? "dark" : "default" });
        const { svg } = await mermaid.render(`terminus-mermaid-${++seq}`, definition);
        if (alive) setSvg(svg);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [definition, dark]);
  if (failed) return <CodeFallback text={definition} />;
  return (
    <View style={{ alignSelf: "stretch", marginVertical: 4 }}>
      {/* `securityLevel: "strict"` limpia el SVG; es el mismo que pinta la ventana. */}
      {svg ? <div style={{ overflowX: "auto", maxWidth: "100%" }} dangerouslySetInnerHTML={{ __html: svg }} /> : null}
    </View>
  );
}

/** Un diagrama que falla al pintarse se queda en su texto; nunca desmonta la conversación. */
class DiagramBoundary extends Component<{ definition: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <CodeFallback text={this.props.definition} /> : this.props.children;
  }
}

export function MermaidDiagram({ definition }: { definition: string }) {
  return (
    <DiagramBoundary key={definition} definition={definition}>
      <Diagram definition={definition} />
    </DiagramBoundary>
  );
}
