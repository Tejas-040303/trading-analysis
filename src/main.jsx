import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <div className="min-h-screen p-4 sm:p-6" style={{ background: "#04070D" }}>
      <div className="mx-auto" style={{ maxWidth: 1100 }}>
        <App />
      </div>
    </div>
  </React.StrictMode>
);
