importScripts("https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js");
importScripts("https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js");

firebase.initializeApp({
   apiKey: "AIzaSyC5az9sNi0x6QoNgHZSbs57ZPSjuZPhr1Q",
   authDomain: "pedelogo-3f824.firebaseapp.com",
   projectId: "pedelogo-3f824",
   storageBucket: "pedelogo-3f824.appspot.com",
   messagingSenderId: "1042917200218",
   appId: "1:1042917200218:web:1141f59d4bf3650a736363",
  databaseURL: "...",
});

const messaging = firebase.messaging();

messaging.setBackgroundMessageHandler(function (payload) {
    const promiseChain = clients
        .matchAll({
            type: "window",
            includeUncontrolled: true
        })
        .then(windowClients => {
            for (let i = 0; i < windowClients.length; i++) {
                const windowClient = windowClients[i];
                windowClient.postMessage(payload);
            }
        })
        .then(() => {
            const title = payload.notification.title;
            const options = {
                body: payload.notification.score
              };
            return registration.showNotification(title, options);
        });
    return promiseChain;
});
self.addEventListener('notificationclick', function (event) {
    console.log('notification received: ', event)
});