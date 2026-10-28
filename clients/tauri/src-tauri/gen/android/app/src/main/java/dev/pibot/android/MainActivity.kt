package dev.pibot.android

import android.os.Bundle
import android.graphics.Color
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.core.view.WindowCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // Only invoked after Rust validates the official Tailscale authorization URL.
  // ACTION_VIEW delegates login to the user's browser; it does not start a VPN.
  @androidx.annotation.Keep
  fun openPiboLogin(url: String): Boolean = try {
    val uri = android.net.Uri.parse(url)
    if (uri.scheme != "https" || uri.host != "login.tailscale.com" || uri.userInfo != null) false
    else {
      startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, uri).addCategory(android.content.Intent.CATEGORY_BROWSABLE))
      true
    }
  } catch (_: Exception) { false }

  // No JavaScript interface: native Rust first matches this exact HTTPS URL to
  // a pending Pi SDK login event. Keep this separate from Tailscale login.
  @androidx.annotation.Keep
  fun openPiboModelLogin(url: String): Boolean = try {
    val uri = android.net.Uri.parse(url)
    if (uri.scheme != "https" || uri.host == null || uri.userInfo != null) false
    else {
      startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, uri).addCategory(android.content.Intent.CATEGORY_BROWSABLE))
      true
    }
  } catch (_: Exception) { false }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.rgb(16, 16, 16))
    )
    super.onCreate(savedInstanceState)
    if (BuildConfig.DEBUG) android.webkit.WebView.setWebContentsDebuggingEnabled(true)
    WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = false
    WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightNavigationBars = false
    window.decorView.setBackgroundColor(Color.rgb(16, 16, 16))
    if (android.os.Build.VERSION.SDK_INT >= 29) {
      window.isNavigationBarContrastEnforced = false
      window.isStatusBarContrastEnforced = false
    }
    // WebView CSS safe-area values are not reliable for Android system bars.
    // Inset the native content, while allowing adjustResize to handle the IME.
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val bottom = if (insets.isVisible(WindowInsetsCompat.Type.ime())) 0 else bars.bottom
      view.setPadding(bars.left, bars.top, bars.right, bottom)
      insets
    }
    ViewCompat.requestApplyInsets(content)
  }
}
