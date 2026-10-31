import React from 'react';
import PortalView from '../components/PortalView';
import { PORTALS } from '../config';

// Dedicated screen for the Amul Intranet portal. The backend menu points here
// with { screen: 'AmulIntranet' } — the URL lives in the app config, not the DB.
const AmulIntranetScreen = () => (
  <PortalView
    baseUrl={PORTALS.AmulIntranet.baseUrl}
    title={PORTALS.AmulIntranet.title}
  />
);

export default AmulIntranetScreen;
