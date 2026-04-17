import { useState } from "react";
import DocxPanel from "./docx/DocxPanel";
import ChatPanel from "./chat/ChatPanel";

export default function App() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [documentName, setDocumentName] = useState<string>("Untitled.docx");
  // Lifted so DocxPanel can pause PUTs while an agent turn is in flight.
  // ChatPanel drives this via its `useAgent` hook.
  const [isAgentTurn, setIsAgentTurn] = useState(false);
  // Timestamp of the most recent checkpoint applied to the editor. Fed by
  // DocxPanel and displayed in ChatPanel's metrics footer.
  const [lastCheckpointAt, setLastCheckpointAt] = useState<number | null>(null);

  return (
    <div className="app-shell">
      <div className="app-shell__doc">
        <DocxPanel
          workspaceId={workspaceId}
          onWorkspaceCreated={setWorkspaceId}
          documentName={documentName}
          onDocumentNameChange={setDocumentName}
          isAgentTurn={isAgentTurn}
          onCheckpointApplied={() => setLastCheckpointAt(Date.now())}
        />
      </div>
      <div className="app-shell__chat">
        <ChatPanel
          workspaceId={workspaceId}
          documentName={documentName}
          onStreamingChange={setIsAgentTurn}
          lastCheckpointAt={lastCheckpointAt}
        />
      </div>
    </div>
  );
}
