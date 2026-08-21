import ReactDOM from "react-dom/client";
import App from "./App";
// Self-hosted variable font (font-display: swap is built into the package's
// @font-face rules; no runtime network fetch).
import "@fontsource-variable/inter";
import "./index.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />);
