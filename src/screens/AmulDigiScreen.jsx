import React from 'react';
import PortalView from '../components/PortalView';
import { PORTALS } from '../config';

// Dedicated screen for the Amul Digi portal. The backend menu points here with
// { screen: 'AmulDigi' } — the base URL lives in the app config, not the DB.
const AmulDigiScreen = () => (
  <PortalView
    baseUrl={PORTALS.AmulDigi.baseUrl}
    title={PORTALS.AmulDigi.title}
  />
);

export default AmulDigiScreen;
