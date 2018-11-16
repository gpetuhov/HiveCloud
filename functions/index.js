'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// Send new chat message notification.
// Listen for new chat messages added to /chatrooms/:chatroomId/messages/:messageId
// and send data FCM message to the receiver of the new chat message.
exports.sendNewChatMessageNotification = functions.firestore.document('/chatrooms/{chatroomUid}/messages/{messageUid}')
	// This is triggered on new document creation
    .onCreate((snap, context) => {
    	// Get chat message from the document
    	const message = snap.data();

    	// Get receiver uid and message text from the chat message
     	const receiverUid = message.receiver_uid;
      	const messageText = message.message_text;

      	// Get receiver user
      	// (in return statement, because this method must return promise)
  		return admin.firestore()
            .collection('users')
            .doc(receiverUid)
            .get()
            .then(doc => {
            	// Get receiver user from the document
 	   	        const receiver = doc.data();

      			// Get receiver user name and username
		        const name = receiver.name;
		        const userName = receiver.username;

		        // Init receiver name with username or name
		        let receiverName;
		        if (userName !== "") {
		        	receiverName = userName;
		        } else {
		        	receiverName = name;
		        }

				// Get receiver user's FCM token		        	
		        const token = receiver.fcm_token;

		        // Create FCM message with receiver name and message text.
		        // We must send DATA FCM message, not notification message
		        // (message contains only "data" part).
		        // This is because notification messages do not trigger
		        // FirebaseMessagingService.onMessageReceived() on the Android device,
		        // when the app is in the BACKGROUND, and we need to show 
		        // new chat message notification exactly when the app is in the background.
		        const payload = {
		          data: {
		    	    receiverName: `${receiverName}`,
		            messageText: `${messageText}`
		          }
		        };

		        // Send FCM message to the device with specified FCM token.
		        // (again in return statement, because this method must return promise)
		        return admin.messaging().sendToDevice(token, payload);
            });
    });