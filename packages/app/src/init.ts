import { App } from "@padloc/core/lib/app.js";
import { setProvider } from "@padloc/core/lib/crypto.js";
import { setPlatform } from "@padloc/core/lib/platform.js";
import { BillingClient } from "@padloc/billing/lib/client.js";
import { WebCryptoProvider } from "./crypto.js";
import { Router } from "./route.js";
import { AjaxSender } from "./ajax.js";
import { WebPlatform } from "./platform.js";
import { LocalStorage } from "./storage.js";

const sender = new AjaxSender((window.env && window.env.serverUrl) || "http://localhost:3000");
export const app = (window.app = new App(new LocalStorage(), sender));
window.billing = new BillingClient(app.state, new AjaxSender(window.env.billingUrl));
export const router = (window.router = new Router());

setPlatform(new WebPlatform());
setProvider(new WebCryptoProvider());
