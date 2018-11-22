'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// === Exports ===

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
		        const receiverName = getUserNameOrUsername(receiver.name, receiver.username);

				// Get receiver user's FCM token		        	
		        const receiverToken = receiver.fcm_token;

		        // Create promise to send FCM message to the device with specified FCM token.
		        const sendNotificationPromise = getSendNotificationPromise(senderUid, senderName, messageText, receiverToken);

		        // Chatrooms are updated inside transactions
		        // to prevent corrupting data by parallel function execution.
				const updateSenderChatroomPromise = getUpdateSenderChatroomPromise(senderUid, receiverUid, senderName, receiverName, messageTimestamp, messageText);
				const updateReceiverChatroomPromise = getUpdateReceiverChatroomPromise(senderUid, receiverUid, senderName, receiverName, messageTimestamp, messageText);

				// Send notification and update sender and receiver chatrooms
				return Promise.all([sendNotificationPromise, updateSenderChatroomPromise, updateReceiverChatroomPromise]);
            });
    });

// -----------------------

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
				let currentReceiverNewMessageCount;

  		    	return transaction.get(receiverChatroomRef)
		    		.then(doc => {
						console.log('Transaction start');

						// Get receiver chatroom from the document
						const receiverChatroom = doc.data();

						currentReceiverNewMessageCount = getNewMessageCount(receiverChatroom.newMessageCount);

						console.log('Current count = ', currentReceiverNewMessageCount);

						if (currentReceiverNewMessageCount === 0) {
							// Do nothing, if new message count is already 0
							console.log('Current count is already 0, do nothing');

							return null;

						} else {
					        // Otherwise get receiver's unread chatroom messages
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

					    	if (unreadMessageCount !== currentReceiverNewMessageCount) {
					    		// If the number of unread chatroom messages is different from the current new message count,
						    	// update new message count of the receiver's chatroom with the number of unread messages.
						      	return transaction.update(receiverChatroomRef, {newMessageCount: unreadMessageCount});
					    	
					    	} else {
					    		// Current new message count is already correct, do nothing
						    	console.log('Current new message count is already correct, do nothing');
					    		return null;
					    	}

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

// === Functions ===

function getUserNameOrUsername(name, userName) {
    return (userName !== undefined && userName !== "") ? userName : name;
}

function getChatroomUid(senderUid, receiverUid) {
    return (senderUid < receiverUid) ? `${senderUid}_${receiverUid}` : `${receiverUid}_${senderUid}`;
}

function getNewMessageCount(tempNewMessageCount) {
	return (tempNewMessageCount !== undefined) ? tempNewMessageCount : 0;
}

function getSendNotificationPromise(senderUid, senderName, messageText, receiverToken) {
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

    // Create promise to send FCM message to the device with specified FCM token.
    return admin.messaging().sendToDevice(receiverToken, payload);
}

function getUpdateSenderChatroomPromise(senderUid, receiverUid, senderName, receiverName, messageTimestamp, messageText) {
    const chatroomUid = getChatroomUid(senderUid, receiverUid);

	let updatedSenderChatroom = getUpdatedChatroom(senderUid, receiverUid, senderName, receiverName);

	const senderChatroomRef = admin.firestore().collection('userChatrooms').doc(senderUid).collection('chatroomsOfUser').doc(chatroomUid);

	return admin.firestore().runTransaction(transaction => {
		    return transaction.get(senderChatroomRef)
				.then(doc => {
					console.log('Update sender chatroom transaction start');

					// Get sender chatroom
					const senderChatroom = doc.data();

					// Get current last message timestamp
					const senderChatroomCurrentLastMessageTimestamp = senderChatroom.lastMessageTimestamp;

					// Update sender chatroom only if this message is newer, 
					// than the last message in the chatroom.
					if (messageTimestamp > senderChatroomCurrentLastMessageTimestamp) {
						console.log('Updating sender chatroom');

						// Update sender chatroom last message
						updatedSenderChatroom["lastMessageSenderUid"] = `${senderUid}`;
						updatedSenderChatroom["lastMessageText"] = `${messageText}`;
						updatedSenderChatroom["lastMessageTimestamp"] = messageTimestamp;

						return transaction.update(senderChatroomRef, updatedSenderChatroom);

					} else {
						console.log('Message is older than sender chatroom last message, do not update');
						return null;
					}
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
}

function getUpdateReceiverChatroomPromise(senderUid, receiverUid, senderName, receiverName, messageTimestamp, messageText) {
    const chatroomUid = getChatroomUid(senderUid, receiverUid);

	let updatedReceiverChatroom = getUpdatedChatroom(senderUid, receiverUid, senderName, receiverName);

	const receiverChatroomRef = admin.firestore().collection('userChatrooms').doc(receiverUid).collection('chatroomsOfUser').doc(chatroomUid);

	return admin.firestore().runTransaction(transaction => {
			let receiverChatroomCurrentLastMessageTimestamp = 0;
			let receiverChatroomCurrentNewMessageCount;

	    	return transaction.get(receiverChatroomRef)
	    		.then(doc => {
					console.log('Update receiver chatroom transaction start');

					// Get receiver chatroom
					const receiverChatroom = doc.data();

					// Get current last message timestamp and new message count
					receiverChatroomCurrentLastMessageTimestamp = receiverChatroom.lastMessageTimestamp;
					receiverChatroomCurrentNewMessageCount = receiverChatroom.newMessageCount;

			        // Get receiver's unread chatroom messages
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

			    	let isCountUpdated = false;
			    	let isLastMessageUpdated = false;

			    	if (unreadMessageCount !== receiverChatroomCurrentNewMessageCount) {
			    		console.log('Include new message count into receiver chatroom update');

				    	// New message count in the receiver chatroom must be updated if is different
						updatedReceiverChatroom["newMessageCount"] = unreadMessageCount;
						isCountUpdated = true;
			    	}

					// Last message in the receiver chatroom should be updated,
					// only if this message is newer.
			    	if (messageTimestamp > receiverChatroomCurrentLastMessageTimestamp) {
			    		console.log('Include last message into receiver chatroom update');

	    				updatedReceiverChatroom["lastMessageSenderUid"] = `${senderUid}`;
						updatedReceiverChatroom["lastMessageText"] = `${messageText}`;
						updatedReceiverChatroom["lastMessageTimestamp"] = messageTimestamp;					    		

						isLastMessageUpdated = true;
			    	}

			    	if (isCountUpdated || isLastMessageUpdated) {
			    		// If new message count or last message should be updated, 
			    		// then update receiver chatroom.
			    		console.log('Updating receiver chatroom');
			    		return transaction.update(receiverChatroomRef, updatedReceiverChatroom);

			    	} else {
			    		// If nothing should be updated, do nothing.
			    		console.log('Nothing to update in receiver chatroom, do nothing');
			    		return null;
			    	}
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
}

function getUpdatedChatroom(senderUid, receiverUid, senderName, receiverName) {
	// These properties are updated anyway
	return {
		userUid1: `${senderUid}`,
		userUid2: `${receiverUid}`,
		userName1: `${senderName}`,
		userName2: `${receiverName}`
	};
}