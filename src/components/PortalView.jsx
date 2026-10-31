import React, { forwardRef } from 'react';
import PortalWebView from './PortalWebView';

// Thin compatibility wrapper.
//
// The real implementation now lives in PortalWebView, which is shared with
// WebViewScreen. This file only adapts the older `baseUrl` prop name, so the
// kept-alive portal hosts in MainNavigator (and AmulDigiScreen /
// AmulIntranetScreen) keep working unchanged.
//
// forwardRef matters: MainNavigator holds a ref to each live portal so a
// single back handler can walk THAT portal's page history. Without the
// forward, the ref would land on this wrapper and be empty.
//
// Props: baseUrl, title, paramNames (optional auth param mapping),
//        prefillEmployeeField (optional login-field id to auto-fill),
//        onCanGoBackChange, handleHardwareBack
const PortalView = forwardRef(
  (
    {
      baseUrl,
      title,
      paramNames,
      prefillEmployeeField,
      viewport,
      onCanGoBackChange,
      handleHardwareBack,
    },
    ref,
  ) => (
    <PortalWebView
      ref={ref}
      url={baseUrl}
      title={title}
      paramNames={paramNames}
      prefillEmployeeField={prefillEmployeeField}
      viewport={viewport}
      onCanGoBackChange={onCanGoBackChange}
      handleHardwareBack={handleHardwareBack}
    />
  ),
);

export default PortalView;
