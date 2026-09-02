/*
  REFERENCE — after running `npx cap add android`, replace the contents
  of android/app/src/main/java/com/nullvault/gymtracker/MainActivity.java
  with this. It's the default Capacitor MainActivity plus one addition:
  disabling native overscroll on the WebView.

  Why: your CSS already sets `overscroll-behavior: none` correctly (it's
  what makes the TWA/Chrome build scroll properly), but Android's System
  WebView — which is what Capacitor uses by default — doesn't reliably
  respect that CSS property on many OS versions and falls back to its
  own rubber-band/glow overscroll. That's the "whole page gets bigger,
  accordion style" effect. Turning overscroll off natively removes it
  regardless of what the WebView's CSS engine does with the property.
*/

package com.nullvault.gymtracker;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
    }
}
