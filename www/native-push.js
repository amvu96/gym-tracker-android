/* ============================================================
   NATIVE PUSH BRIDGE
   Only runs inside the Capacitor native shell (window.Capacitor
   exists there, not in the plain web/TWA build). Registers this
   device for FCM push and stores the token against the current
   user doc so a Cloud Function (or your own backend) can send
   pushes later, e.g. "rest day reminder" or "streak about to break".
   ============================================================ */

(function () {
  if (!window.Capacitor || !window.Capacitor.isNativePlatform()) return;

  const { PushNotifications } = window.Capacitor.Plugins;
  if (!PushNotifications) return;

  async function initPush() {
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;

    await PushNotifications.register();

    PushNotifications.addListener('registration', async (token) => {
      // Reuses your existing firebase-sync.js auth/user state.
      // Adjust `getCurrentUserId()` to whatever your app already
      // exposes for the signed-in user.
      try {
        const uid = window.getCurrentUserId ? window.getCurrentUserId() : null;
        if (!uid || !window.firebaseDb) return;
        await window.firebaseDb
          .collection('users')
          .doc(uid)
          .set({ fcmToken: token.value, platform: 'android' }, { merge: true });
      } catch (e) {
        console.warn('Failed to save push token', e);
      }
    });

    PushNotifications.addListener('registrationError', (err) => {
      console.warn('Push registration error', err);
    });

    // Foreground notification received while app is open
    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      console.log('Push received in foreground', notification);
    });

    // User tapped a notification
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      console.log('Push tapped', action.notification);
    });
  }

  document.addEventListener('DOMContentLoaded', initPush);
})();
