import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { decodeJwt } from "jose";
import { z } from "zod/v4";
import {
  RefreshResponseSchema,
  TokenPayload,
  TokenPayloadSchema,
  UserMeResponse,
  UserMeResponseSchema,
} from "../core/ApiSchemas";

const isNative = Capacitor.getPlatform() !== "web";

function getAudience() {
  const hostname =
    process.env.CAPACITOR_PRODUCTION_HOSTNAME ||
    new URL(window.location.href).hostname;
  const domainname = hostname.split(".").slice(-2).join(".");
  return domainname;
}

function getApiBase() {
  const domainname = getAudience();
  return domainname === "localhost"
    ? (localStorage.getItem("apiHost") ??
      (isNative && process.env.API_BASE_URL))
      ? process.env.API_BASE_URL!.replace("9000", "8787")
      : "http://localhost:8787"
    : `https://api.${domainname}`;
}

function getToken(): string | null {
  const { hash } = window.location;
  if (hash.startsWith("#")) {
    const params = new URLSearchParams(hash.slice(1));
    const token = params.get("token");
    if (token) {
      localStorage.setItem("token", token);
    }
    // Clean the URL
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  return localStorage.getItem("token");
}

export async function discordLogin() {
  let redirectUri: string;

  if (isNative) {
    redirectUri = `${process.env.API_BASE_URL}/discord-redirect.html`;
  } else {
    redirectUri = window.location.href.split("#")[0];
  }

  const url = `${getApiBase()}/login/discord?redirect_uri=${encodeURIComponent(redirectUri)}`;

  if (isNative) {
    await Browser.open({ url });
  } else {
    window.location.href = url;
  }
}

export async function logOut(allSessions: boolean = false) {
  const token = localStorage.getItem("token");
  if (token === null) return;
  localStorage.removeItem("token");
  __isLoggedIn = false;

  const response = await fetch(
    getApiBase() + (allSessions ? "/revoke" : "/logout"),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );

  if (response.ok === false) {
    console.error("Logout failed", response);
    return false;
  }
  return true;
}

export type IsLoggedInResponse =
  | { token: string; claims: TokenPayload }
  | false;
let __isLoggedIn: IsLoggedInResponse | undefined = undefined;
export function isLoggedIn(): IsLoggedInResponse {
  if (__isLoggedIn === undefined) {
    __isLoggedIn = _isLoggedIn();
  }
  return __isLoggedIn;
}
function _isLoggedIn(): IsLoggedInResponse {
  try {
    const token = getToken();
    if (!token) {
      // console.log("No token found");
      return false;
    }

    // Verify the JWT (requires browser support)
    // const jwks = createRemoteJWKSet(
    //   new URL(getApiBase() + "/.well-known/jwks.json"),
    // );
    // const { payload, protectedHeader } = await jwtVerify(token, jwks, {
    //   issuer: getApiBase(),
    //   audience: getAudience(),
    // });

    // Decode the JWT
    const payload = decodeJwt(token);
    const { iss, aud, exp, iat } = payload;

    if (iss !== getApiBase() && !isNative) {
      // JWT was not issued by the correct server
      console.error(
        'unexpected "iss" claim value',
        // JSON.stringify(payload, null, 2),
      );
      logOut();
      return false;
    }
    if (aud !== getAudience()) {
      // JWT was not issued for this website
      console.error(
        'unexpected "aud" claim value',
        // JSON.stringify(payload, null, 2),
      );
      logOut();
      return false;
    }
    const now = Math.floor(Date.now() / 1000);
    if (exp !== undefined && now >= exp) {
      // JWT expired
      console.error(
        'after "exp" claim value',
        // JSON.stringify(payload, null, 2),
      );
      logOut();
      return false;
    }
    const refreshAge: number = 6 * 3600; // 6 hours
    if (iat !== undefined && now >= iat + refreshAge) {
      console.log("Refreshing access token...");
      postRefresh().then((success) => {
        if (success) {
          console.log("Refreshed access token successfully.");
        } else {
          console.error("Failed to refresh access token.");
        }
      });
    }

    const result = TokenPayloadSchema.safeParse(payload);
    if (!result.success) {
      const error = z.prettifyError(result.error);
      // Invalid response
      console.error("Invalid payload", error);
      return false;
    }

    const claims = result.data;
    return { token, claims };
  } catch (e) {
    console.log(e);
    return false;
  }
}

export function initializeAuthListener() {
  if (Capacitor.getPlatform() === "web") return;

  App.addListener("appUrlOpen", async (data) => {
    try {
      const url = new URL(data.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        console.error("Error from auth provider:", error);
        await Browser.close();
        return;
      }

      if (code && state) {
        const redirectUri = `${process.env.API_BASE_URL}/discord-redirect.html`;
        const response = await fetch(`${getApiBase()}/mobile/callback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            code,
            state,
            redirect_uri: redirectUri,
          }),
        });

        if (!response.ok) {
          throw new Error(
            `Failed to exchange code for token: ${response.statusText}`,
          );
        }

        const { token } = await response.json();

        if (token) {
          localStorage.setItem("token", token);
          __isLoggedIn = undefined;
          await Browser.close();
          window.location.assign(window.location.origin || "/");
        } else {
          console.error("No token found in response");
          await Browser.close();
        }
      }
    } catch (e) {
      console.error("Error handling appUrlOpen", e);
      await Browser.close();
    }
  });
}

export async function postRefresh(): Promise<boolean> {
  try {
    const token = getToken();
    if (!token) return false;

    // Refresh the JWT
    const response = await fetch(getApiBase() + "/refresh", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    if (response.status !== 200) return false;
    const body = await response.json();
    const result = RefreshResponseSchema.safeParse(body);
    if (!result.success) {
      const error = z.prettifyError(result.error);
      console.error("Invalid response", error);
      return false;
    }
    localStorage.setItem("token", result.data.token);
    return true;
  } catch (e) {
    __isLoggedIn = false;
    return false;
  }
}

export async function getUserMe(): Promise<UserMeResponse | false> {
  try {
    const token = getToken();
    if (!token) return false;

    // Get the user object
    const response = await fetch(getApiBase() + "/users/@me", {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    if (response.status !== 200) return false;
    const body = await response.json();
    const result = UserMeResponseSchema.safeParse(body);
    if (!result.success) {
      const error = z.prettifyError(result.error);
      console.error("Invalid response", error);
      return false;
    }
    return result.data;
  } catch (e) {
    __isLoggedIn = false;
    return false;
  }
}
