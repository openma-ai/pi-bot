package dev.pibot.android

import android.os.Bundle
import android.graphics.Color
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.core.view.WindowCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
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
