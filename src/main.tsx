import React from "react";
import ReactDOM from "react-dom/client";
import App from "./components/App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/editor.css";
import "./styles/docx.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
