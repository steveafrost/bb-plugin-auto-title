import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { sourceContract } from "./contracts";

type Sources = { selected: string; choices: { id: string; name: string; status: { ready: boolean; message?: string } }[] };

function ModelPicker() {
  const rpc = useRpc<typeof sourceContract>();
  const [data, setData] = useState<Sources>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setError("");
    try { setData(await rpc.call("sources.list", null)); } catch { setError("Could not load model sources."); }
  }
  useEffect(() => { void refresh(); }, []);
  async function save(source: string) {
    setBusy(true);
    setError("");
    try {
      const result = await rpc.call("sources.set", { source });
      setData((current) => current && { ...current, selected: result.selected });
    } catch { setError("Could not save the model source. Refresh the list and try again."); }
    finally { setBusy(false); }
  }
  const selected = data?.choices.find((choice) => choice.id === data.selected);
  return <div style={{ display: "grid", gap: 8, maxWidth: 420 }}>
    <label htmlFor="auto-title-source">Model source</label>
    <select id="auto-title-source" value={data?.selected ?? ""} disabled={!data || busy} onChange={(event) => void save(event.target.value)}
      style={{ color: "inherit", background: "var(--background)", border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
      {!data && <option value="">Loading sources…</option>}
      {data && !selected && <option value={data.selected}>Unavailable source</option>}
      {data?.choices.map(({ id, name, status }) => <option key={id} value={id}>{name}{status.ready ? "" : " (not ready)"}</option>)}
    </select>
    {selected?.status.message && <div>{selected.status.message}</div>}
    {error && <div role="alert">{error}</div>}
    <button type="button" onClick={() => void refresh()} disabled={busy} style={{ justifySelf: "start", padding: "4px 0", textDecoration: "underline" }}>Refresh sources</button>
  </div>;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "model-source", title: "Title model", description: "Automatic tries your endpoint, BB Cloud, installed AI plugins, then the thread provider.", component: ModelPicker });
});
