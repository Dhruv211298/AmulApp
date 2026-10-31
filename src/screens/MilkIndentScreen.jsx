import React from 'react';
import PortalView from '../components/PortalView';
import { PORTALS } from '../config';

// Dedicated screen for the Milk Indent portal. The backend menu points here
// with { screen: 'MilkIndent' } — the URL lives in the app config, not the DB.
const MilkIndentScreen = () => (
  <PortalView
    baseUrl={PORTALS.MilkIndent.baseUrl}
    title={PORTALS.MilkIndent.title}
  />
);

export default MilkIndentScreen;
