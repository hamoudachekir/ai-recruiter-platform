# Streamoji Avatar Widget Integration

## Overview
This document describes the integration of the Streamoji AvatarWidget (@streamoji/avatar-widget) into the call room interface.

## Installation

```bash
npm install @streamoji/avatar-widget
```

## Environment Setup

Add to `Frontend/.env`:
```dotenv
VITE_STREAMOJI_AGENT_ID=client_w8omf96Fz4UhrTg2UAKGzhcHzlE3
```

Add to root `.env` (backend only, never expose the secret to frontend):
```dotenv
STREAMOJI_CLIENT_ID=client_w8omf96Fz4UhrTg2UAKGzhcHzlE3
STREAMOJI_CLIENT_SECRET=Yd1CFvEpZF1uIiIWiu7sitJ7CFHFoH9F
```

## Component Structure

### StreamojiAvatarWrapper.jsx
- Wraps the `AvatarWidget` from Streamoji
- Handles React Router navigation instead of opening new tabs
- Listens to `agent-speech` events to coordinate with the call room
- Hides itself on specific routes (e.g., avatar creator pages)
- Passes logged-in user details for personalization

### Integration Points

1. **Navigation Handling**: Uses React Router's `useNavigate()` to handle URL navigation requests from the widget
2. **Event Coordination**: Listens to the existing `agent-speech` custom event emitted by CallRoomActive
3. **User Context**: Reads user details from localStorage and passes them to the widget (optional)
4. **Path-based Visibility**: Hides the widget on routes containing `/createAvatar` or `/avatar-creator`

## Usage

Mount the wrapper in your root layout or the component that wraps your routes:

```jsx
import StreamojiAvatarWrapper from './interview/StreamojiAvatarWrapper';

export function App() {
  return (
    <Routes>
      <Route path="/call-room/:roomId" element={<CallRoomActive />} />
      {/* other routes */}
    </Routes>
    <StreamojiAvatarWrapper />
  );
}
```

Or in the call room itself:

```jsx
import StreamojiAvatarWrapper from './StreamojiAvatarWrapper';

export default function CallRoomActive() {
  return (
    <div>
      <StreamojiAvatarWrapper />
      {/* rest of call room UI */}
    </div>
  );
}
```

## API Details

### Widget Features
- **Fixed Positioning**: Renders in bottom-right corner with z-index 9999
- **Lead Capture**: Can skip lead capture if `presetUserDetails` are provided
- **Navigation**: Calls `onNavigationRequested` when the agent wants to open a URL
- **Avatar Interaction**: Shows the agent avatar and responds to user text input

### Event Flow

```
User interaction in widget
         ↓
agent-speech event → handleAgentSpeech
         ↓
Pause/resume widget or coordinate state
```

## Optional Customization

### Pause/Resume During Agent Speech
The wrapper attempts to call `window.AvatarWidget.pause()` and `window.AvatarWidget.resume()` when the agent is speaking. If Streamoji's API doesn't support this, these calls are silently ignored.

### User Details
If your app has authentication, you can pass additional user details:
```javascript
presetUserDetails: {
  name: "John Doe",
  email: "john@example.com",
  phone: "+1234567890"
}
```

### Route-based Visibility
Modify the condition in the visibility `useEffect` to hide the widget on other routes:
```javascript
const shouldHide = location.pathname.includes('/admin') || location.pathname.includes('/settings');
```

## Troubleshooting

### Widget Not Appearing
- Check that `VITE_STREAMOJI_AGENT_ID` is set correctly in `.env`
- Verify that the `@streamoji/avatar-widget` package is installed
- Check browser console for initialization errors

### Navigation Not Working
- Ensure the URL passed to `onNavigationRequested` is valid
- Check React Router setup and `useNavigate()` hook
- Verify routes are defined in your router

### Duplicate Widgets
- The wrapper is designed to initialize once per mount
- Avoid mounting the wrapper multiple times in the same component tree
- If you see duplicates, check for multiple component renders

## Backend Token/Session (If Required)

If Streamoji requires a backend session token, add a route like:

```javascript
// Backend: Backend/server/routes/streamojiRoute.js
router.post('/session', verifyToken, async (req, res) => {
  try {
    const token = await exchangeStreamojiToken();
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

Then call it from the wrapper:
```javascript
const response = await fetch('/api/streamoji/session', {
  headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
});
const { token } = await response.json();
```

## References
- Streamoji Docs: https://www.npmjs.com/package/@streamoji/avatar-widget
- React Router: https://reactrouter.com/
