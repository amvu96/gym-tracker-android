/*
  REFERENCE ONLY — copy into android/app/src/main/java/.../widget/
  after running `npx cap add android` (step 3 in BUILD-STEPS.md).

  This is a minimal Glance widget showing today's workout / streak.
  It reads from SharedPreferences that the WebView writes to via a
  tiny Capacitor plugin bridge (see notes at bottom).
*/

package com.nullvault.gymtracker.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.provideContent
import androidx.glance.text.Text
import androidx.glance.layout.Column
import androidx.glance.layout.padding
import androidx.compose.ui.unit.dp

class GymTrackerWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val prefs = context.getSharedPreferences("gym_tracker_widget", Context.MODE_PRIVATE)
        val streak = prefs.getInt("streak", 0)
        val todayLabel = prefs.getString("today_label", "No workout logged yet") ?: ""

        provideContent {
            Column(modifier = androidx.glance.GlanceModifier.padding(12.dp)) {
                Text(text = "🔥 Streak: $streak days")
                Text(text = todayLabel)
            }
        }
    }
}

/*
  NOTES:
  1. Register this widget in AndroidManifest.xml + a widget_info.xml
     (standard Glance boilerplate — Android Studio's "App Widget"
     wizard scaffolds this for you: File > New > Widget).

  2. To get data INTO SharedPreferences from your JS app, add a
     tiny custom Capacitor plugin (WidgetBridgePlugin.java) with
     one method, e.g. `updateWidgetData(streak, todayLabel)`, that
     writes to the same SharedPreferences name/keys above, then
     calls GlanceAppWidgetManager(context).getGlanceIds(...) and
     updateAll() to refresh the widget.

  3. Call it from JS after every workout save:
       Capacitor.Plugins.WidgetBridge.updateWidgetData({
         streak: currentStreak, todayLabel: "Push Day • 45 min"
       });

  This part genuinely requires touching native code — there's no
  way around it, widgets don't exist in the WebView layer. But it's
  ~80 lines total, not a rewrite of your app.
*/
