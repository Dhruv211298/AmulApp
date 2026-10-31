import React from 'react';
import PortalView from '../components/PortalView';
import { PORTALS } from '../config';

// Dedicated screen for the Amul Dashboard portal. The backend menu points here
// with { screen: 'AmulDashboard' } — the URL lives in the app config, not the DB.
const AmulDashboardScreen = () => (
  <PortalView
    baseUrl={PORTALS.AmulDashboard.baseUrl}
    title={PORTALS.AmulDashboard.title}
  />
);

export default AmulDashboardScreen;
