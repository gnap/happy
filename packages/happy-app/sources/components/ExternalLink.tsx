import { Link } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { Platform, Text as RNText } from 'react-native';

export function ExternalLink(
  props: Omit<React.ComponentProps<typeof Link>, 'href'> & { href: string }
) {
  const { href, children, target: _target, rel: _rel, download: _download, ...rest } = props as any;

  if (Platform.OS === 'web') {
    return (
      <Link
        target="_blank"
        {...rest}
        href={href as any}
      >
        {children}
      </Link>
    );
  }

  return (
    <RNText
      {...rest}
      onPress={() => {
        // Open the link in Expo's in-app browser on native.
        void WebBrowser.openBrowserAsync(href);
      }}
    >
      {children}
    </RNText>
  );
}
