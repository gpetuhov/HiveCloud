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
		        chatroomUid = getChatroomUid(senderUid, receiverUid);

		        // Get receiver's unread chatroom messages
		      	// (in return statement, because this method must return promise)
		        return admin.firestore()
		        	.collection('chatrooms')
		        	.doc(chatroomUid)
		        	.collection('messages')
		        	.where('isRead', '==', false)
		        	.where('receiver_uid', '==', receiverUid)
		        	.get()
            })
			.then(snapshot => {
				// Count the number of unread chatroom messages
				const unreadMessageCount = snapshot.empty ? 0 : snapshot.size;

		    	console.log('unreadMessageCount = ', unreadMessageCount);

				const updatedChatroom = {
					userUid1: `${senderUid}`,
					userUid2: `${receiverUid}`,
					userName1: `${senderName}`,
					userName2: `${receiverName}`,
					lastMessageSenderUid: `${senderUid}`,
					lastMessageText: `${messageText}`,
					lastMessageTimestamp: messageTimestamp
				};

				// In receiver's chatroom we must also update new message counter.
				// So we copy updatedChatroom into updatedReceiverChatroom
				// and add one more property for new message count.
				let updatedReceiverChatroom = Object.assign({}, updatedChatroom);
				updatedReceiverChatroom["newMessageCount"] = unreadMessageCount;

				const senderChatroomRef = admin.firestore().collection('userChatrooms').doc(senderUid).collection('chatroomsOfUser').doc(chatroomUid);
				const receiverChatroomRef = admin.firestore().collection('userChatrooms').doc(receiverUid).collection('chatroomsOfUser').doc(chatroomUid);

				const updateSenderChatroomPromise = admin.firestore().runTransaction(transaction => {
	  		    	return transaction.get(senderChatroomRef)
			    		.then(doc => {
							console.log('Update sender chatroom transaction start');
					      	return transaction.update(senderChatroomRef, updatedChatroom);
				    	})
					})
					.then(result => {
						console.log('Update sender chatroom transaction success!');
						return null;
					})
					.catch(err => {
						console.log('Update sender chatroom transaction failure:', err);
						return null;
					});

				const updateReceiverChatroomPromise = admin.firestore().runTransaction(transaction => {
	  		    	return transaction.get(receiverChatroomRef)
			    		.then(doc => {
							console.log('Update receiver chatroom transaction start');
					      	return transaction.update(receiverChatroomRef, updatedReceiverChatroom);
				    	})
					})
					.then(result => {
						console.log('Update receiver chatroom transaction success!');
						return null;
					})
					.catch(err => {
						console.log('Update receiver chatroom transaction failure:', err);
						return null;
					});

				// Update sender and receiver chatrooms
				return Promise.all([updateSenderChatroomPromise, updateReceiverChatroomPromise]);
			})
			.then(response => {
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

// ===========================

// If the message is marked as read, determine current number of unread messages
// and update new message count of the receiver's chatroom with this number.
exports.onUpdateChatMessage = functions.firestore.document('/chatrooms/{chatroomUid}/messages/{messageUid}')
	// This is triggered on document update
    .onUpdate((change, context) => {
    	// Get old chat message
    	const oldMessage = change.before.data();
    	// Get new chat message
    	const newMessage = change.after.data();

     	const senderUid = newMessage.sender_uid;
     	const receiverUid = newMessage.receiver_uid;

    	if (oldMessage.isRead === true || newMessage.isRead === false) {
    		// If message has not been marked as read during this update,
    		// then do nothing.
    		return null;

    	} else {
	        // Create chatroom UID
	        const chatroomUid = getChatroomUid(senderUid, receiverUid);

	        // Receiver's chatroom reference
	        const receiverChatroomRef = admin.firestore().collection('userChatrooms').doc(receiverUid).collection('chatroomsOfUser').doc(chatroomUid);

	        // Run new message counter update inside the transaction
	        // to prevent corrupting data by parallel function execution.
	        // Transaction will restart from the beginning, if the data
	        // (the receiver's chatroom new message counter)
	        // is modified by another function instance execution.
			return admin.firestore().runTransaction(transaction => {
  		    	return transaction.get(receiverChatroomRef)
		    		.then(doc => {
						console.log('Transaction start');

						// Get receiver chatroom from the document
						const receiverChatroom = doc.data();

						const currentReceiverNewMessageCount = getNewMessageCount(receiverChatroom.newMessageCount);

						console.log('Current count = ', currentReceiverNewMessageCount);

						if (currentReceiverNewMessageCount === 0) {
							// Do nothing, if new message count is already 0
							console.log('Current count is already 0, do nothing');

							return null;

						} else {
					        // Get receiver's unread chatroom messages
					        return admin.firestore()
					        	.collection('chatrooms')
					        	.doc(chatroomUid)
					        	.collection('messages')
					        	.where('isRead', '==', false)
					        	.where('receiver_uid', '==', receiverUid)
								.get()
						}
			    	})
					.then(snapshot => {
						if (snapshot !== null) {
							// Count the number of unread chatroom messages
							const unreadMessageCount = snapshot.empty ? 0 : snapshot.size;

					    	console.log('unreadMessageCount = ', unreadMessageCount);

					    	// Update new message count of the receiver's chatroom with the number of unread messages
					      	return transaction.update(receiverChatroomRef, {newMessageCount: unreadMessageCount});

					    } else {
					    	// Snapshot is null (because current new message count is already 0 int previous then()),
					    	// do nothing.
					    	console.log('Snapshot is null, do nothing');
					    	return null;
					    }
					})
				})
				.then(result => {
					console.log('Transaction success!');
					return null;
				})
				.catch(err => {
					console.log('Transaction failure:', err);
					return null;
				});
    	}
    });

// ===========================

function getUserNameOrUsername(name, userName) {
    return (userName !== undefined && userName !== "") ? userName : name;
}

function getChatroomUid(senderUid, receiverUid) {
    return (senderUid < receiverUid) ? `${senderUid}_${receiverUid}` : `${receiverUid}_${senderUid}`;
}

function getNewMessageCount(tempNewMessageCount) {
	return (tempNewMessageCount !== undefined) ? tempNewMessageCount : 0;
}