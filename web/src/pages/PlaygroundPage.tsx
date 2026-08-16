import { protocolEndpoint } from "../api";
import { Button } from "../bflabs/Button";
import { Tabs } from "../bflabs/Tabs";
import { hrefFor } from "../nav";
import { identityLabel, type RosterItem } from "../roster";
import type { Protocol } from "../types";
import { PageFrame } from "./shared";

export function PlaygroundPage({
  t,
  roster,
  activeId,
  protocol,
  selectedModel,
  prompt,
  stream,
  output,
  runState,
  onActive,
  onProtocol,
  onModel,
  onPrompt,
  onStream,
  onRun,
}: {
  t: {
    title: string;
    pick: string;
    prompt: string;
    send: string;
    sending: string;
    stream: string;
    events: string;
    emptyOutput: string;
    waiting: string;
    accounts: string;
  };
  roster: RosterItem[];
  activeId: string;
  protocol: Protocol;
  selectedModel: string;
  prompt: string;
  stream: boolean;
  output: string;
  runState: string;
  onActive: (id: string) => void;
  onProtocol: (value: Protocol) => void;
  onModel: (value: string) => void;
  onPrompt: (value: string) => void;
  onStream: (value: boolean) => void;
  onRun: () => void;
}) {
  const active = roster.find((item) => item.id === activeId);
  const models = active?.models;

  return (
    <PageFrame title={t.title}>
      <label className="field page-field">
        <span>{t.pick}</span>
        <select value={activeId} onChange={(event) => onActive(event.target.value)}>
          {roster.length === 0 ? <option value="">{t.waiting}</option> : null}
          {roster.map((item) => (
            <option key={item.id} value={item.id}>
              {identityLabel(item.account, item.keyHint)}
            </option>
          ))}
        </select>
      </label>
      {roster.length === 0 ? <p className="empty"><a href={hrefFor("accounts")}>{t.accounts}</a></p> : null}

      <Tabs
        className="bf-tabs--bare"
        label="Protocol"
        value={protocol}
        onValueChange={(value) => onProtocol(value as Protocol)}
        items={([
          { value: "messages", label: "Messages" },
          { value: "chat", label: "Chat" },
          { value: "responses", label: "Responses" },
        ] as const).map((item) => ({
          value: item.value,
          label: item.label,
          content: null,
        }))}
      />

      <form
        className="form page-form"
        onSubmit={(event) => {
          event.preventDefault();
          onRun();
        }}
      >
        <div className="meta">
          <code className="path">POST {protocolEndpoint(protocol)}</code>
          <div className="stream">
            <button type="button" className={stream ? "is-on" : ""} onClick={() => onStream(true)}>{t.stream}</button>
            <button type="button" className={!stream ? "is-on" : ""} onClick={() => onStream(false)}>JSON</button>
          </div>
        </div>
        <label className="field page-field">
          <span>Model</span>
          <select value={selectedModel} onChange={(event) => onModel(event.target.value)}>
            <option value="" disabled>{t.waiting}</option>
            {models?.data.map((model) => (
              <option key={model.id} value={model.id}>{model.display_name || model.id}</option>
            ))}
          </select>
        </label>
        <label className="field page-field">
          <span>{t.prompt}</span>
          <textarea value={prompt} onChange={(event) => onPrompt(event.target.value)} />
        </label>
        <div className="sendrow">
          <Button type="submit" variant="primary" size="sm" loading={runState === "loading"} disabled={!active || !selectedModel || runState === "loading"}>
            {runState === "loading" ? t.sending : t.send}
          </Button>
        </div>
      </form>
      <h2 className="subhead">{t.events}</h2>
      <pre className="out page-out">{output || t.emptyOutput}</pre>
    </PageFrame>
  );
}
