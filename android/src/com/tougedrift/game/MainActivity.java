package com.tougedrift.game;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Fullscreen WebView running the game build bundled in assets/www. Files are served from a
 * virtual https origin (like androidx WebViewAssetLoader) so ES modules, fetch() and
 * localStorage behave exactly as on a web server, and large assets stream on demand.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("glb", "model/gltf-binary");
        MIME.put("jpg", "image/jpeg");
        MIME.put("png", "image/png");
        MIME.put("webp", "image/webp");
        MIME.put("svg", "image/svg+xml");
        MIME.put("wasm", "application/wasm");
    }

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= 28) {
            getWindow().getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // settings are saved in localStorage
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!HOST.equals(request.getUrl().getHost())) return null;
                String path = request.getUrl().getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                try {
                    InputStream in = getAssets().open("www" + path);
                    String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
                    String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
                    return new WebResourceResponse(mime, mime.startsWith("text") ? "utf-8" : null, in);
                } catch (IOException e) {
                    WebResourceResponse notFound = new WebResourceResponse("text/plain", "utf-8", null);
                    notFound.setStatusCodeAndReasonPhrase(404, "Not Found");
                    return notFound;
                }
            }
        });
        web.setBackgroundColor(0xFF0D0F12);
        setContentView(web);
        hideSystemUi();
        web.loadUrl("https://" + HOST + "/index.html");
    }

    private void hideSystemUi() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    /** Back pauses the game while driving; otherwise it leaves the app. */
    @Override
    public void onBackPressed() {
        web.evaluateJavascript(
                "(function(){var d=window.__drift;if(d&&d.ui.state==='driving'){d.ui.showPause();return 'p';}"
                        + "if(d&&(d.ui.state==='settings'||d.ui.state==='pause')){d.ui.state==='settings'?d.ui.closeSettings():d.ui.resume();return 'p';}return 'x';})()",
                value -> {
                    if (value != null && value.contains("x")) MainActivity.super.onBackPressed();
                });
    }

    @Override
    protected void onPause() {
        web.evaluateJavascript("window.__drift&&window.__drift.ui.state==='driving'&&window.__drift.ui.showPause()", null);
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        hideSystemUi();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
