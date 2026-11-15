import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/global.css';
import './styles/dashboard.css';
import './styles/glass.css';
import './styles/impact.css';
import './styles/history.css';
createRoot(document.getElementById('root')).render(<App />);
