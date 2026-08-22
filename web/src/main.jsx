import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(<App />);

// Service worker only registers over HTTPS or on localhost. That is an iOS
// requirement, not a choice — see the README on installing to the home screen.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline shell unavailable; the app still works online */
    });
  });
}
