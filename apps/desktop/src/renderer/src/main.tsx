import { createRoot } from "react-dom/client";
import { Provider } from "./api";
import App from "./App";
import "./style.css";
const initialDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.classList.toggle("dark", initialDark);
document.documentElement.dataset.theme = initialDark ? "dark" : "light";
createRoot(document.getElementById("root")!).render(
  <Provider>
    <App />
  </Provider>,
);

