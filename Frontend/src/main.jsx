import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './lib/httpAuth'; // Registers the global axios 401 handler (clear session + redirect to login)
import './index.css'; // Tailwind directives — preflight disabled, scoped via [data-wizard-scope]
import './Dashboard/_styles/index.scss'; // Import Dashboard styles
import "bootstrap-icons/font/bootstrap-icons.css";
// Bootstrap's collapse / dropdown plugins power the front-office Navbar's
// hamburger toggle at viewports below the `navbar-expand-lg` breakpoint
// (<992px). Without this import the toggle button does nothing and the nav
// links stay hidden behind it.
import "bootstrap/dist/js/bootstrap.bundle.min.js";

// Render the App component inside the root element
createRoot(document.getElementById('root')).render(
  <App />
);