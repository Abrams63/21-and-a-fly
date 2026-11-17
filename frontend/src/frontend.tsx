import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import "./analytics";
import "./global.css";

const elem = document.getElementById("root");
if (!elem) throw new Error("index.html has no #root element");
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// https://bun.com/docs/bundler/hot-reloading#import-meta-hot-data
type HotData = { root?: Root };
const hot = import.meta.hot.data as HotData;
hot.root ??= createRoot(elem);
hot.root.render(app);
