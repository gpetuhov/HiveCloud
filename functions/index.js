'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// Listen for new chat messages added to /chatrooms/:chatroomId/messages/:messageId ,
// update corresponding chatroom of the sender and the receiver,
// and send data FCM message to the receiver of the new chat message.
exports.onNewChatMessage = functions.firestore.document('/chatrooms/{chatroomUid}/messages/{messageUid}')
	// This is triggered on new document creation
    .onCreate((snap, context) => {
    	// Get chat message from the document
    	const message = snap.data();

    	// Get sender uid, receiver uid and message text from the chat message
     	const senderUid = message.sender_uid;
     	const receiverUid = message.receiver_uid;
      	const messageText = message.message_text;
      	const messageTimestamp = message.timestamp;

      	console.log('***');
      	console.log('Message timestamp = ', messageTimestamp);

        let senderName;
        let receiverName;
        let receiverToken;

		let chatroomUid;

		// Get sender user
		// (in return statement, because this method must return promise)
  		return admin.firestore()
            .collection('users')
            .doc(senderUid)
            .get()
            .then(doc => {
            	// Get sender user from the document
 	   	        const sender = doc.data();

		        // Init sender name with username or name
		        senderName = getUserNameOrUsername(sender.name, sender.username);

		      	// Get receiver user
		      	// (in return statement, because this method must return promise)
		  		return admin.firestore().collection('users').doc(receiverUid).get();
		    })
            .then(doc => {
            	// Get receiver user from the document
 	   	        const receiver = doc.data();

		        // Init receiver name with username or name
		        receiverName = getUserNameOrUsername(receiver.name, receiver.username);

				// Get receiver user's FCM token		        	
		        receiverToken = receiver.fcm_token;

		        // Create chatroom UID
		        if (senderUid < receiverUid) {
		        	chatroomUid = `${senderUid}_${receiverUid}`;
		        } else {
		        	chatroomUid = `${receiverUid}_${senderUid}`;
		        }

		        // Get receiver's chatroom
		      	// (in return statement, because this method must return promise)
		  		return admin.firestore().collection('userChatrooms').doc(receiverUid).collection('chatroomsOfUser').doc(chatroomUid).get();
            })
			.then(doc => {
				// Get receiver chatroom from the document
				const receiverChatroom = doc.data();

				// Get current new message count
				const tempReceiverNewMessageCount = receiverChatroom.newMessageCount;

				// If new message count is undefined, set to 0
				let currentReceiverNewMessageCount;
				if (tempReceiverNewMessageCount !== undefined) {
					currentReceiverNewMessageCount = tempReceiverNewMessageCount;
				} else {
					currentReceiverNewMessageCount = 0;
				}

				// Increment new message count by 1
				const incrementedReceiverNewMessageCount = currentReceiverNewMessageCount + 1;

				const updatedChatroom = {
					userUid1: `${senderUid}`,
					userUid2: `${receiverUid}`,
					userName1: `${senderName}`,
					userName2: `${receiverName}`,
					lastMessageSenderUid: `${senderUid}`,
					lastMessageText: `${messageText}`,
					lastMessageTimestamp: messageTimestamp
				};

				console.log('Updated chatroom = ', updatedChatroom);

				// In receiver's chatroom we must also update new message counter.
				// So we copy updatedChatroom into updatedReceiverChatroom
				// and add one more property for new message count.
				let updatedReceiverChatroom = Object.assign({}, updatedChatroom);
				updatedReceiverChatroom["newMessageCount"] = incrementedReceiverNewMessageCount;

				console.log('Updated receiver chatroom = ', updatedReceiverChatroom);

				// Create promise to update sender chatroom
				const updateSenderChatroomPromise = admin
					.firestore()
					.collection('userChatrooms')
					.doc(senderUid)
					.collection('chatroomsOfUser')
					.doc(chatroomUid)
					.set(updatedChatroom, {merge: true});

				// Create promise to update receiver chatroom
				const updateReceiverChatroomPromise = doc.ref.set(updatedReceiverChatroom, {merge: true});

				// Update sender and receiver chatrooms
				return Promise.all([updateSenderChatroomPromise, updateReceiverChatroomPromise]);
			})
			.then(response => {
				console.log('response = ', response); 

		        // Create FCM message with sender uid and name and message text.
		        // We must send DATA FCM message, not notification message
		        // (message contains only "data" part).
		        // This is because notification messages do not trigger
		        // FirebaseMessagingService.onMessageReceived() on the Android device,
		        // when the app is in the BACKGROUND, and we need to show 
		        // new chat message notification exactly when the app is in the background.
		        const payload = {
		          data: {
		    	    senderUid: `${senderUid}`,
		    	    senderName: `${senderName}`,
		            messageText: `${messageText}`
		          }
		        };

		        // Send FCM message to the device with specified FCM token.
		        // (again in return statement, because this method must return promise)
		        return admin.messaging().sendToDevice(receiverToken, payload);
            });
    });

function getUserNameOrUsername(name, userName) {
	let result;

    if (userName !== "") {
    	result = userName;
    } else {
    	result = name;
    }

    return result;
}