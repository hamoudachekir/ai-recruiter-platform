const express = require("express");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const { OAuth2Client } = require("google-auth-library");
const { UserModel } = require("../models/user");

const router = express.Router();

const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
];

const DEFAULT_GOOGLE_CALLBACK_PATH = "/auth/google/callback";

const toAbsoluteRedirectUri = (req, configuredValue) => {
  const value = String(configuredValue || "").trim();
  if (!value) return null;

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  if (value.startsWith("/")) {
    return `${req.protocol}://${req.get("host")}${value}`;
  }

  return null;
};

const getRedirectUri = (req) => {
  const configuredRedirectUri =
    toAbsoluteRedirectUri(req, process.env.GOOGLE_CALENDAR_REDIRECT_URI) ||
    toAbsoluteRedirectUri(req, process.env.GOOGLE_REDIRECT_URI);

  if (configuredRedirectUri) return configuredRedirectUri;

  return `${req.protocol}://${req.get("host")}${DEFAULT_GOOGLE_CALLBACK_PATH}`;
};

const encodeState = (payload) =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

const decodeState = (state) => {
  const encoded = String(state || "").trim();
  const normalized = encoded.replaceAll(" ", "+");

  try {
    return JSON.parse(Buffer.from(normalized, "base64url").toString("utf8"));
  } catch (base64UrlError) {
    try {
      return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    } catch (base64Error) {
      console.debug("Invalid OAuth state payload", {
        base64UrlError: base64UrlError?.message,
        base64Error: base64Error?.message,
      });
      return null;
    }
  }
};

const buildOAuthClient = (redirectUri) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { client: null, clientId, clientSecret };
  }

  return {
    client: new OAuth2Client(clientId, clientSecret, redirectUri),
    clientId,
    clientSecret,
  };
};

const isValidRecruiter = (user) => {
  if (!user) return false;
  return user.role === "ENTERPRISE" || user.role === "ADMIN";
};

const popupHtmlResponse = (success, title, message) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f6f8fb; color: #1f2937; margin: 0; padding: 24px; }
    .card { max-width: 520px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12); padding: 20px; }
    h3 { margin-top: 0; }
    .ok { color: #15803d; }
    .ko { color: #b91c1c; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h3 class="${success ? "ok" : "ko"}">${title}</h3>
    <p>${message}</p>
    <p>You can close this window.</p>
  </div>
  <script>
    (function () {
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(
            {
              type: "GOOGLE_CALENDAR_CONNECTED",
              success: ${success ? "true" : "false"},
              message: ${JSON.stringify(message)}
            },
            "*"
          );
        }
      } catch (err) {
        console.error(err);
      }
    })();
  </script>
</body>
</html>
`;

router.get("/connect-url/:recruiterId", async (req, res) => {
  try {
    const { recruiterId } = req.params;
    const redirectUri = getRedirectUri(req);

    if (!mongoose.Types.ObjectId.isValid(recruiterId)) {
      return res.status(400).json({ message: "Invalid recruiterId" });
    }

    const { client, clientId, clientSecret } = buildOAuthClient(redirectUri);
    if (!client || !clientId || !clientSecret) {
      return res.status(500).json({
        message: "Google OAuth credentials are not configured on the server",
      });
    }

    const recruiter = await UserModel.findById(recruiterId).select("email role");
    if (!isValidRecruiter(recruiter)) {
      return res.status(403).json({
        message: "Only recruiter/enterprise accounts can connect Google Calendar",
      });
    }

    const state = encodeState({ recruiterId, ts: Date.now() });
    const authUrl = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      login_hint: recruiter.email || undefined,
      scope: GOOGLE_CALENDAR_SCOPES,
      state,
    });

    return res.status(200).json({
      authUrl,
      redirectUri,
      scopes: GOOGLE_CALENDAR_SCOPES,
    });
  } catch (error) {
    console.error("❌ Failed to generate Google Calendar connect URL:", error);
    return res.status(500).json({ message: "Failed to generate connect URL" });
  }
});

const handleGoogleOAuthCallback = async (req, res) => {
  const {
    code,
    state,
    error: oauthError,
    error_description: oauthErrorDescription,
    error_subtype: oauthErrorSubtype,
  } = req.query;

  try {
    const redirectUri = getRedirectUri(req);

    if (oauthError) {
      const errorCode = String(oauthError || "").trim();
      const errorDescription = String(oauthErrorDescription || "").trim();
      const errorSubtype = String(oauthErrorSubtype || "").trim();

      let message =
        errorDescription || "Google OAuth flow was denied or blocked before token exchange.";

      if (errorCode === "access_denied") {
        message =
          "Google denied access. If your OAuth app is in testing mode, add this email in Google Cloud Console > APIs & Services > OAuth consent screen > Test users.";
      }

      if (errorSubtype) {
        message = `${message} (subtype: ${errorSubtype})`;
      }

      return res
        .status(403)
        .send(popupHtmlResponse(false, "Calendar Connection Denied", message));
    }

    if (!code || !state) {
      return res
        .status(400)
        .send(popupHtmlResponse(false, "Calendar Connection Failed", "Missing OAuth callback parameters."));
    }

    const statePayload = decodeState(state);
    const recruiterId = statePayload?.recruiterId;

    if (!mongoose.Types.ObjectId.isValid(String(recruiterId || ""))) {
      return res
        .status(400)
        .send(popupHtmlResponse(false, "Calendar Connection Failed", "Invalid recruiter state."));
    }

    const { client, clientId, clientSecret } = buildOAuthClient(redirectUri);
    if (!client || !clientId || !clientSecret) {
      return res
        .status(500)
        .send(popupHtmlResponse(false, "Calendar Connection Failed", "Google OAuth credentials are missing."));
    }

    const recruiter = await UserModel.findById(recruiterId).select(
      "+googleCalendar.accessToken +googleCalendar.refreshToken +googleCalendar.tokenExpiry +googleCalendar.calendarId +googleCalendar.connectedAt email role"
    );

    if (!isValidRecruiter(recruiter)) {
      return res
        .status(403)
        .send(popupHtmlResponse(false, "Calendar Connection Failed", "Recruiter account not authorized."));
    }

    const { tokens } = await client.getToken(code);
    if (!tokens?.access_token) {
      return res
        .status(400)
        .send(popupHtmlResponse(false, "Calendar Connection Failed", "Google did not return an access token."));
    }

    recruiter.googleCalendar = recruiter.googleCalendar || {};
    recruiter.googleCalendar.accessToken = tokens.access_token;
    if (tokens.refresh_token) {
      recruiter.googleCalendar.refreshToken = tokens.refresh_token;
    }
    recruiter.googleCalendar.tokenExpiry = tokens.expiry_date
      ? new Date(tokens.expiry_date)
      : recruiter.googleCalendar.tokenExpiry || null;
    recruiter.googleCalendar.connectedAt = new Date();
    recruiter.googleCalendar.calendarId = recruiter.googleCalendar.calendarId || "primary";

    await recruiter.save();

    return res
      .status(200)
      .send(popupHtmlResponse(true, "Calendar Connected", "Google Calendar is now connected to your recruiter account."));
  } catch (error) {
    console.error("❌ Google Calendar OAuth callback failed:", error?.response?.data || error);
    return res
      .status(500)
      .send(
        popupHtmlResponse(
          false,
          "Calendar Connection Failed",
          error?.message || "Unexpected server error while connecting calendar."
        )
      );
  }
};

router.get("/oauth/callback", handleGoogleOAuthCallback);
router.get("/callback", handleGoogleOAuthCallback);

router.get("/status/:recruiterId", async (req, res) => {
  try {
    const { recruiterId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(recruiterId)) {
      return res.status(400).json({ message: "Invalid recruiterId" });
    }

    const recruiter = await UserModel.findById(recruiterId).select(
      "+googleCalendar.accessToken +googleCalendar.refreshToken +googleCalendar.tokenExpiry +googleCalendar.calendarId +googleCalendar.connectedAt name email role"
    );

    if (!isValidRecruiter(recruiter)) {
      return res.status(403).json({
        message: "Only recruiter/enterprise accounts can access calendar status",
      });
    }

    const accessToken = recruiter.googleCalendar?.accessToken || null;
    const refreshToken = recruiter.googleCalendar?.refreshToken || null;
    const tokenExpiry = recruiter.googleCalendar?.tokenExpiry || null;

    return res.status(200).json({
      recruiterId: String(recruiter._id),
      connected: Boolean(accessToken),
      connectedAt: recruiter.googleCalendar?.connectedAt || null,
      calendarId: recruiter.googleCalendar?.calendarId || "primary",
      hasRefreshToken: Boolean(refreshToken),
      tokenExpiry,
      tokenExpired: tokenExpiry ? new Date(tokenExpiry).getTime() <= Date.now() : null,
      email: recruiter.email,
      role: recruiter.role,
      name: recruiter.name,
    });
  } catch (error) {
    console.error("❌ Failed to fetch recruiter calendar status:", error);
    return res.status(500).json({ message: "Failed to fetch calendar status" });
  }
});

router.post("/test-email", async (req, res) => {
  try {
    const { recruiterId, toEmail } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(String(recruiterId || ""))) {
      return res.status(400).json({ message: "Valid recruiterId is required" });
    }

    const recruiter = await UserModel.findById(recruiterId).select("name email role");
    if (!isValidRecruiter(recruiter)) {
      return res.status(403).json({
        message: "Only recruiter/enterprise accounts can trigger test emails",
      });
    }

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return res.status(400).json({
        message: "EMAIL_USER and EMAIL_PASS must be configured to send test emails",
      });
    }

    const recipient = String(toEmail || recruiter.email || "").trim();
    if (!recipient) {
      return res.status(400).json({
        message: "No recipient email available for test message",
      });
    }

    const transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: `"AI Recruiter Platform" <${process.env.EMAIL_USER}>`,
      to: recipient,
      subject: "AI Recruiter - Calendar Connection Test Email",
      text: `Hello ${recruiter.name || "Recruiter"}, your calendar/email integration is active.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1f2937;">
          <h2 style="margin-bottom: 8px;">Integration test successful</h2>
          <p>Hello <strong>${recruiter.name || "Recruiter"}</strong>,</p>
          <p>This is a test email from AI Recruiter Platform. Your email path for interview notifications is working.</p>
          <p>You can now proceed with candidate acceptance and automated scheduling.</p>
        </div>
      `,
    });

    return res.status(200).json({
      message: `Test email sent successfully to ${recipient}`,
      sentTo: recipient,
    });
  } catch (error) {
    console.error("❌ Failed to send recruiter test email:", error);
    return res.status(500).json({
      message: error?.message || "Failed to send test email",
    });
  }
});

module.exports = router;
