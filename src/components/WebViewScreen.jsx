import React from 'react';
import PortalWebView from './PortalWebView';

// Thin route adapter for the generic in-app portal.
//
// Registered as the 'WebView' stack screen and opened from the sidebar for any
// backend menu item that carries a `url`. The real implementation is shared
// with PortalView via PortalWebView.
//
// Route params: { url, title }
const WebViewScreen = ({ route }) => {
  const { url, title } = (route && route.params) || {};
  return <PortalWebView url={url} title={title} />;
};

export default WebViewScreen;
