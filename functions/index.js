'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const firestore = admin.firestore();
const firebase = admin.database();
const bucket = admin.storage().bucket();

// This is needed to remove timestamp warning
const settings = {timestampsInSnapshots: true};
firestore.settings(settings);

// Collections will be recursively deleted in batches of this size
const deleteCollectionBatchSize = 100;

// === Exports ===

// Listen for new chat messages added to /chatrooms/:chatroomId/messages/:messageId ,
// update corresponding chatroom of the sender and the receiver,
// and send data FCM message to the receiver of the new chat message.
// Note that if the function does not execute for some reason (due to error or server down),
// then chatrooms will NOT be updated. Only next time the function is invoked 
// (when another new message is created). There is nothing we can do about it.
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
      	const messageTimestampMillis = messageTimestamp.toMillis();

        let senderName;
        let senderUserPicUrl;

		// Get sender user
		// (in return statement, because this method must return promise)
  		return firestore
            .collection('users')
            .doc(senderUid)
            .get()
            .then(doc => {
            	// Get sender user from the document
 	   	        const sender = doc.data();

		        // Init sender name with username or name
		        senderName = getUserNameOrUsername(sender.name, sender.username);

		        // Get sender user pic URL
		        senderUserPicUrl = sender.userPicUrl;

		      	// Get receiver user
		      	// (in return statement, because this method must return promise)
		  		return firestore.collection('users').doc(receiverUid).get();
		    })
            .then(doc => {
            	// Get receiver user from the document
 	   	        const receiver = doc.data();

		        // Init receiver name with username or name
		        const receiverName = getUserNameOrUsername(receiver.name, receiver.username);

		        // Get receiver user pic URL
		        const receiverUserPicUrl = receiver.userPicUrl;

				// Get receiver user's FCM token		        	
		        const receiverToken = receiver.fcm_token;

		        // Create promise to send FCM message to the device with specified FCM token.
		        const sendNotificationPromise = getSendNotificationPromise(senderUid, senderName, senderUserPicUrl, messageText, messageTimestampMillis, receiverToken);

		        // Chatrooms are updated inside transactions
		        // to prevent corrupting data by parallel function execution.
				const updateSenderChatroomPromise = getUpdateSenderChatroomOnCreatePromise(senderUid, receiverUid, senderName, receiverName, senderUserPicUrl, receiverUserPicUrl, messageTimestamp, messageText);
				const updateReceiverChatroomPromise = getUpdateReceiverChatroomOnCreatePromise(senderUid, receiverUid, senderName, receiverName, senderUserPicUrl, receiverUserPicUrl, messageTimestamp, messageText);

				// Send notification and update sender and receiver chatrooms
				return Promise.all([sendNotificationPromise, updateSenderChatroomPromise, updateReceiverChatroomPromise]);
            });
    });

// -----------------------

// If the message is marked as read, determine current number of unread messages
// and update new message count of the receiver's chatroom with this number.
// Note that if this function is not executed, 
// then the receiver chatroom counter will not be updated
// (only after the sender sends another message, and the receiver receives it).
// There is nothing we can do about it.
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
    		// Otherwise update receiver chatroom
    		return getUpdateReceiverChatroomOnUpdatePromise(senderUid, receiverUid);
    	}
    });

// -----------------------

// Callable function
// Updates username and userpic in chatrooms
exports.updateUserNameAndPicInChatrooms = functions.https.onCall((data, context) => {
	const userUid = data.userUid;
	const newUsername = data.newUsername;
	const newUserPicUrl = data.newUserPicUrl;

	// Checking that the user is authenticated.
	if (!context.auth) {
	  // Throwing an HttpsError so that the client gets the error details.
	  throw new functions.https.HttpsError('failed-precondition', 'The function must be called while authenticated.');
	}

	// Update username or user pic in the chatrooms of the user
	return getUserChatroomsAndUpdateUsername(userUid, newUsername, newUserPicUrl);
});    

// -----------------------

// Callable function.
// Called directly from the app on review create, update and delete.
// Recalculates and updates corresponding offer rating in provider user
// (the user who provides this offer).
exports.recalculateRating = functions.https.onCall((data, context) => {
	// Checking that the user is authenticated.
	if (!context.auth) {
	  // Throwing an HttpsError so that the client gets the error details.
	  throw new functions.https.HttpsError('failed-precondition', 'The function must be called while authenticated.');
	}

 	const providerUserUid = data.providerUserUid;
 	const offerUid = data.offerUid;
	const offerReviewsDocumentUid = data.offerReviewsDocumentUid;

  	let providerUser;

  	const providerUserRef = firestore.collection('users').doc(providerUserUid);

  	// Update provider user offer rating list in transaction
  	// (this is needed, because several reviews on the same offer 
  	// can be posted at the same time)
    return firestore.runTransaction(transaction => {
	    return transaction.get(providerUserRef)
			.then(doc => {
				// Get provider user
 	   	        providerUser = doc.data();

	            // Get offer reviews
 	   	        return getOfferReviewsPromise(offerReviewsDocumentUid);
	    	})
	    	.then(snapshot => {
	    		// Calculate new offer rating based on all reviews of this offer
	            const offerRatings = recalculateOfferRatings(snapshot, providerUser, offerUid);

	            // Update only offer rating array in provider user
				const updatedProviderUser = {
					offerRatingList: offerRatings
				};

				return transaction.update(providerUserRef, updatedProviderUser);
	    	})
	})
	.then(result => {
		return null;
	})
	.catch(err => {
		console.log('Update provider user transaction failure:', err);
		return null;
	});
});    

// -----------------------

// Callable function
// Called directly from the app to delete offer related data on manual offer delete
exports.deleteOfferData = functions.https.onCall((data, context) => {
	// Checking that the user is authenticated.
	if (!context.auth) {
	  // Throwing an HttpsError so that the client gets the error details.
	  throw new functions.https.HttpsError('failed-precondition', 'The function must be called while authenticated.');
	}

	const userUid = data.userUid;
	const offerUid = data.offerUid;

	// Delete offer reviews.
	// We don't have to delete offer photos here, because this is done from the app.
	return getDeleteOfferReviewsPromise(userUid, offerUid, deleteCollectionBatchSize)
		.then(() => {
			// Delete offer rating list item for the offer being deleted
			return deleteOfferRatingListItem(userUid, offerUid);
		});
});    

// -----------------------

// On every user online status update in Realtime Database
// update user online status in Firestore.
exports.onUserStatusChange = functions.database.ref('/online/{userUid}')
	.onUpdate((change, context) => {
    	const newStatus = change.after.val();
    	const userUid = context.params.userUid;

    	if (newStatus === true) {
    		// If user online, do nothing
	    	return null;

    	} else {
    		// Otherwise set user online status false and last seen time in Firestore
    		return firestore.collection('users')
    					.doc(userUid)
						.set({
							is_online: false,
							last_seen: Date.now()
						}, {merge: true});
    	}
	});

// -----------------------

// On every user isHiveRunning status update in Realtime Database
// update user isHiveRunning status in Firestore.
exports.onUserIsHiveRunningChange = functions.database.ref('/isHiveRunning/{userUid}')
	.onUpdate((change, context) => {
    	const newIsHiveRunning = change.after.val();
    	const userUid = context.params.userUid;

    	if (newIsHiveRunning === true) {
    		// If isHiveRunning true, do nothing
	    	return null;

    	} else {
    		// Otherwise set isHiveRunning false in Firestore
    		return firestore.collection('users')
    					.doc(userUid)
						.set({isHiveRunning: false}, {merge: true});
    	}
	});

// -----------------------

// Delete user document in Firestore on user delete in FirebaseAuth.
// Note that here we listen to FirebaseAuth, NOT Firestore!

// Chain of triggers:
// 1. User deleted in FirebaseAuth (onUserDelete) -> Delete user document in Firestore
// 2. User document deleted in Firestore (onUserDocumentDelete) -> Delete user related data in Firestore, including chatrooms of user
// 3. Chatroom of user deleted (onChatroomOfUserDelete) -> Delete all chatroom messages, if second user does not exist
exports.onUserDelete = functions.auth.user()
	.onDelete((user) => {
    	const userUid = user.uid;

	    // Delete user document
		firestore.collection('users').doc(userUid).delete();

		return null;
	});

// -----------------------

// Delete user related data (orphaned data) on user document delete in Firestore
exports.onUserDocumentDelete = functions
	.runWith({	// Extend default limits, because recursive data deletion may take up much resources
		timeoutSeconds: 540,
		memory: '2GB'
	})
	.firestore.document('users/{userUid}')
    .onDelete((snap, context) => {
    	const userUid = context.params.userUid;
    	const deletedUser = snap.data();

	    let deleteFavoritesPromise = getDeleteFavoritesPromise(userUid, deleteCollectionBatchSize);

	    // Running this promise will in turn trigger onChatroomOfUserDelete()
	    let deleteChatroomsOfUserPromise = getDeleteChatroomsOfUserPromise(userUid, deleteCollectionBatchSize);

	    let deleteAllOffersPromise = getDeleteAllOffersPromise(userUid, deletedUser);

		// Delete favorites and chatrooms of user
		return Promise.all([deleteFavoritesPromise, deleteChatroomsOfUserPromise, deleteAllOffersPromise])
			.then(() => {
			    deleteUserOnlineValue(userUid);
				deleteUserPic(userUid, deletedUser);
				deleteUserPhotos(userUid, deletedUser);
				return;
			});
    });

// -----------------------

// Remove all chatroom messages on chatroomOfUser delete, if second user does not exist.
// This gets triggered if user removes his chatroom or when the user is deleted.
exports.onChatroomOfUserDelete = functions
	.runWith({	// Extend default limits, because recursive data deletion may take up much resources
		timeoutSeconds: 540,
		memory: '2GB'
	})
	.firestore.document('userChatrooms/{userUid}/chatroomsOfUser/{chatroomUid}')
    .onDelete((snap, context) => {
    	const userUid = context.params.userUid;
    	const chatroomUid = context.params.chatroomUid;

    	const deletedChatroom = snap.data();
    	const secondUserUid = deletedChatroom.secondUserUid;

	    // Get second user in the chat
	    return firestore
            .collection('users')
            .doc(secondUserUid)
            .get()
            .then(doc => {
            	if (!doc.exists) {
            		// If second user not exists, delete all chatroom messages
            		return getDeleteChatroomMessagesPromise(chatroomUid, deleteCollectionBatchSize);
            	
            	} else {
            		// Otherwise do NOT delete messages, because second user still needs them
			  		return null;
            	}
		    })
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

function getUserChatroomRef(userUid, chatroomUid) {
	return firestore.collection('userChatrooms').doc(userUid).collection('chatroomsOfUser').doc(chatroomUid);
}

function getUpdatedChatroom(secondUserUid, secondUserName, secondUserPicUrl) {
	// These properties are updated anyway
	return {
		secondUserUid: `${secondUserUid}`,
		secondUserName: `${secondUserName}`,
		secondUserPicUrl: `${secondUserPicUrl}`
	};
}

function updateChatroomLastMessage(chatroom, messageText, messageTimestamp) {
	chatroom["lastMessageText"] = `${messageText}`;
	chatroom["lastMessageTimestamp"] = messageTimestamp;					    		

	return chatroom;
}

function getSendNotificationPromise(senderUid, senderName, senderUserPicUrl, messageText, messageTimestampMillis, receiverToken) {
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
	    senderUserPicUrl: `${senderUserPicUrl}`,
        messageText: `${messageText}`,
        messageTimestamp: `${messageTimestampMillis}`
      }
    };

    // Create promise to send FCM message to the device with specified FCM token.
    return admin.messaging().sendToDevice(receiverToken, payload);
}

function getReceiverChatroomUnreadMessagesPromise(chatroomUid, receiverUid) {
    return firestore
    	.collection('chatrooms')
    	.doc(chatroomUid)
    	.collection('messages')
    	.where('isRead', '==', false)
    	.where('receiver_uid', '==', receiverUid)
		.get()
}

function getUpdateSenderChatroomOnCreatePromise(senderUid, receiverUid, senderName, receiverName, senderUserPicUrl, receiverUserPicUrl, messageTimestamp, messageText) {
    const chatroomUid = getChatroomUid(senderUid, receiverUid);
	const senderChatroomRef = getUserChatroomRef(senderUid, chatroomUid);

	// For sender chatroom second user is the receiver
	let updatedSenderChatroom = getUpdatedChatroom(receiverUid, receiverName, receiverUserPicUrl);

	return firestore.runTransaction(transaction => {
		    return transaction.get(senderChatroomRef)
				.then(doc => {
					// Get sender chatroom
					const senderChatroom = doc.data();

					updatedSenderChatroom = updateChatroomLastMessage(updatedSenderChatroom, messageText, messageTimestamp);

					if (senderChatroom === undefined) {
						// Chatroom does not exist yet.
						// Create it instead of updating.
						return transaction.set(senderChatroomRef, updatedSenderChatroom);

					} else {
						// Get current last message timestamp
						const senderChatroomCurrentLastMessageTimestamp = senderChatroom.lastMessageTimestamp;

						// Update sender chatroom only if this message is newer, 
						// than the last message in the chatroom.
						if (senderChatroomCurrentLastMessageTimestamp === undefined || messageTimestamp.toMillis() > senderChatroomCurrentLastMessageTimestamp.toMillis()) {
							return transaction.update(senderChatroomRef, updatedSenderChatroom);

						} else {
							// Message is older than sender chatroom last message, do not update
							return null;
						}
					}
		    	})
		})
		.then(result => {
			return null;
		})
		.catch(err => {
			console.log('Update sender chatroom transaction failure:', err);
			return null;
		});
}

function getUpdateReceiverChatroomOnCreatePromise(senderUid, receiverUid, senderName, receiverName, senderUserPicUrl, receiverUserPicUrl, messageTimestamp, messageText) {
    const chatroomUid = getChatroomUid(senderUid, receiverUid);
	const receiverChatroomRef = getUserChatroomRef(receiverUid, chatroomUid);

	// For receiver chatroom second user is the sender
	let updatedReceiverChatroom = getUpdatedChatroom(senderUid, senderName, senderUserPicUrl);

	return firestore.runTransaction(transaction => {
			let receiverChatroom;
			let receiverChatroomCurrentLastMessageTimestamp = 0;
			let receiverChatroomCurrentNewMessageCount;

	    	return transaction.get(receiverChatroomRef)
	    		.then(doc => {
					// Get receiver chatroom
					receiverChatroom = doc.data();

					// Get current last message timestamp and new message count
					receiverChatroomCurrentLastMessageTimestamp = receiverChatroom !== undefined ? receiverChatroom.lastMessageTimestamp : undefined;
					receiverChatroomCurrentNewMessageCount = receiverChatroom !== undefined ? receiverChatroom.newMessageCount : 0;

			        // Get receiver's unread chatroom messages
			        return getReceiverChatroomUnreadMessagesPromise(chatroomUid, receiverUid);
		    	})
		    	.then(snapshot => {
					// Count the number of unread chatroom messages
					const unreadMessageCount = snapshot.empty ? 0 : snapshot.size;

			    	let isCountUpdated = false;
			    	let isLastMessageUpdated = false;

				    // New message count in the receiver chatroom must be updated only if it is different
			    	if (unreadMessageCount !== receiverChatroomCurrentNewMessageCount) {
						updatedReceiverChatroom["newMessageCount"] = unreadMessageCount;
						isCountUpdated = true;
			    	}

					// Last message in the receiver chatroom should be updated,
					// only if this message is newer.
			    	if (receiverChatroomCurrentLastMessageTimestamp === undefined || messageTimestamp.toMillis() > receiverChatroomCurrentLastMessageTimestamp.toMillis()) {
						updatedReceiverChatroom = updateChatroomLastMessage(updatedReceiverChatroom, messageText, messageTimestamp);			    		
						isLastMessageUpdated = true;
			    	}

			    	if (receiverChatroom === undefined) {
						// Chatroom does not exist yet.
						// Create it instead of updating.
			    		return transaction.set(receiverChatroomRef, updatedReceiverChatroom);

			    	} else {
				    	if (isCountUpdated || isLastMessageUpdated) {
				    		// If new message count or last message should be updated, 
				    		// then update receiver chatroom.
				    		return transaction.update(receiverChatroomRef, updatedReceiverChatroom);

				    	} else {
				    		// If nothing should be updated, do nothing.
				    		return null;
				    	}
			    	}
		    	})
		})
		.then(result => {
			return null;
		})
		.catch(err => {
			console.log('Update receiver chatroom transaction failure:', err);
			return null;
		});
}

function getUpdateReceiverChatroomOnUpdatePromise(senderUid, receiverUid) {
    const chatroomUid = getChatroomUid(senderUid, receiverUid);
    const receiverChatroomRef = getUserChatroomRef(receiverUid, chatroomUid);

    // Run new message counter update inside the transaction
    // to prevent corrupting data by parallel function execution.
    // Transaction will restart from the beginning, if the data
    // (the receiver's chatroom new message counter)
    // is modified by another function instance execution.
	return firestore.runTransaction(transaction => {
			let currentReceiverNewMessageCount;

		    return transaction.get(receiverChatroomRef)
	    		.then(doc => {
					// Get receiver chatroom from the document
					const receiverChatroom = doc.data();

					currentReceiverNewMessageCount = getNewMessageCount(receiverChatroom.newMessageCount);

					if (currentReceiverNewMessageCount === 0) {
						// Do nothing, if new message count is already 0
						return null;

					} else {
				        // Otherwise get receiver's unread chatroom messages
				        return getReceiverChatroomUnreadMessagesPromise(chatroomUid, receiverUid);
					}
		    	})
				.then(snapshot => {
					if (snapshot !== null) {
						// Count the number of unread chatroom messages
						const unreadMessageCount = snapshot.empty ? 0 : snapshot.size;

				    	if (unreadMessageCount !== currentReceiverNewMessageCount) {
				    		// If the number of unread chatroom messages is different from the current new message count,
					    	// update new message count of the receiver's chatroom with the number of unread messages.
					      	return transaction.update(receiverChatroomRef, {newMessageCount: unreadMessageCount});
				    	
				    	} else {
				    		// Current new message count is already correct, do nothing
				    		return null;
				    	}

				    } else {
				    	// Snapshot is null (because current new message count is already 0 int previous then()),
				    	// do nothing.
				    	return null;
				    }
				})
		})
		.then(result => {
			return null;
		})
		.catch(err => {
			console.log('Transaction failure:', err);
			return null;
		});
}

function getUserChatroomsAndUpdateUsername(userUid, newUsername, newUserPicUrl) {
	// Get user's chatrooms and update username inside them
	return firestore
		.collection('userChatrooms')
		.doc(userUid)
		.collection('chatroomsOfUser')
		.get()
		.then(snapshot => {
			if (!snapshot.empty) {
				// Update username in chatrooms
				return getUpdateUsernameInChatroomsPromise(snapshot, newUsername, newUserPicUrl);

    		} else {
    			// No user chatrooms found, do nothing
      			return null;
    		} 
		});
}

function getUpdateUsernameInChatroomsPromise(snapshot, newUsername, newUserPicUrl) {
    let updateChatroomPromiseArray = [];

    // For all chatrooms of the user
    for (let i = 0; i < snapshot.size; i++) {
        const chatroom = snapshot.docs[i].data();
    	const chatroomUid = snapshot.docs[i].id;
        const secondUserUid = chatroom.secondUserUid;

		const updatedChatroom = {
			secondUserName: `${newUsername}`,
			secondUserPicUrl: `${newUserPicUrl}`
		};

        // Create promises to change username in the chatroom for SECOND user only
		updateChatroomPromiseArray.push(getUpdateChatroomForUserPromise(chatroomUid, secondUserUid, updatedChatroom));
    }

    return Promise.all(updateChatroomPromiseArray);
}

function getUpdateChatroomForUserPromise(chatroomUid, userUid, updatedChatroom) {
    const chatroomRef = getUserChatroomRef(userUid, chatroomUid);

	return firestore.runTransaction(transaction => {
		    return transaction.get(chatroomRef)
				.then(doc => {
					return transaction.update(chatroomRef, updatedChatroom);
		    	})
		})
		.then(result => {
			return null;
		})
		.catch(err => {
			console.log('Update username in chatroom transaction failure:', err);
			return null;
		});
}

function getOfferReviewsPromise(offerReviewsDocument) {
    return firestore
    	.collection('reviews')
    	.doc(offerReviewsDocument)
    	.collection('reviewsOfOffer')
    	.orderBy('timestamp', 'desc')
		.get()
}

function recalculateOfferRatings(snapshot, providerUser, offerUid) {
	let newReviewCount = 0;
	let ratingSum = 0;
	let averageRating = 0;

  	// Get offer rating list
  	let offerRatings = providerUser.offerRatingList;

  	if (offerRatings === undefined) {
  		// If user has no reviews yet, create new offer rating array
  		offerRatings = [];
  	}

  	// Find index of current offer's rating
  	const index = offerRatings.findIndex( item => item.offer_uid === offerUid );

	if (snapshot.empty) {
		// If no reviews left (all reviews have been deleted),
		// remove current offer's rating (if exists).
	  	if (index >= 0 && index < offerRatings.length) {
   			offerRatings.splice(index, 1);
	  	}

	} else {
		// Otherwise update current offer's rating.
		newReviewCount = snapshot.size;

		let latestReview;
		let i = 0;

		snapshot.forEach(doc => {
			const reviewItem = doc.data();

			if (i === 0) {
				latestReview = reviewItem;
			}

			ratingSum = ratingSum + reviewItem.rating;

			i++;
		});

		averageRating = ratingSum / newReviewCount;

		let offerRating;

	  	if (index >= 0 && index < offerRatings.length) {
	   		// Current offer's rating exist
	      	offerRating = offerRatings[index];

	      	offerRating.offer_rating = averageRating;
	      	offerRating.offer_review_count = newReviewCount;
			offerRating.offer_last_review_author_name = latestReview.authorName;
			offerRating.offer_last_review_author_pic = latestReview.authorUserPicUrl;
			offerRating.offer_last_review_text = latestReview.text;
			offerRating.offer_last_review_timestamp = latestReview.timestamp;

	  	} else {
	  		// Otherwise (this is the first review on the current offer)
	  		// create new rating and add it to offer rating array.
			offerRating = {
				offer_uid: offerUid,
				offer_rating: averageRating,
				offer_review_count: newReviewCount,
				offer_last_review_author_name: latestReview.authorName,
				offer_last_review_author_pic: latestReview.authorUserPicUrl,
				offer_last_review_text: latestReview.text,
				offer_last_review_timestamp: latestReview.timestamp
			};

			offerRatings.push(offerRating);
	  	}
	}

  	return offerRatings;
}

// --- Delete collection ---
// Code taken from https://firebase.google.com/docs/firestore/manage-data/delete-data#collections
// Recursively delete collection in batches of provided size.

function deleteCollection(collectionPath, batchSize) {
	let collectionRef = firestore.collection(collectionPath);
	let query = collectionRef.orderBy('__name__').limit(batchSize);

	return new Promise((resolve, reject) => {
		deleteQueryBatch(query, batchSize, resolve, reject);
	});
}

function deleteQueryBatch(query, batchSize, resolve, reject) {
	query.get()
		.then((snapshot) => {
			// When there are no documents left, we are done
			if (snapshot.size === 0) {
				return 0;
			}

			// Delete documents in a batch
			let batch = firestore.batch();
			snapshot.docs.forEach((doc) => {
				batch.delete(doc.ref);
			});

			return getCommitBatchPromise(batch, snapshot);
		})
		.then((numDeleted) => {
			if (numDeleted === 0) {
				resolve();
				return;
			}

			// Recurse on the next process tick, to avoid
			// exploding the stack.
			process.nextTick(() => {
				deleteQueryBatch(query, batchSize, resolve, reject);
			});

			return;
		})
		.catch(reject);
}

function getCommitBatchPromise(batch, snapshot) {
	return batch.commit()
		.then(() => {
			return snapshot.size;
		});
}

// -------------------------

// Delete favorites collection in batches
function getDeleteFavoritesPromise(userUid, batchSize) {
	return deleteCollection(`userFavorites/${userUid}/favoritesOfUser`, batchSize);
}

// Delete chatroomsOfUser collection in batches
function getDeleteChatroomsOfUserPromise(userUid, batchSize) {
	return deleteCollection(`userChatrooms/${userUid}/chatroomsOfUser`, batchSize);
}

// Delete chatroom messages collection in batches
function getDeleteChatroomMessagesPromise(chatroomUid, batchSize) {
	return deleteCollection(`chatrooms/${chatroomUid}/messages`, batchSize);
}

// Delete user online value from Realtime Database
function deleteUserOnlineValue(userUid) {
	firebase.ref('online/' + userUid).remove();
}

// Delete user pic if exists
function deleteUserPic(userUid, user) {
	let userPicUrl = user.userPicUrl;
	if (userPicUrl !== undefined && userPicUrl !== "") {
		bucket.file(`${userUid}/userpic.jpg`).delete();
	}
}

// Delete user photos, if exist
function deleteUserPhotos(userUid, user) {
	let photoList = user.photoList;
	deletePhotos(userUid, photoList, 'user_photos');
}

// Delete all user offers
function getDeleteAllOffersPromise(userUid, user) {
    let deleteOfferPromiseArray = [];

	let offerList = user.offerList;
	if (offerList !== undefined) {
		offerList.forEach((offer) => {
			deleteOfferPromiseArray.push(getDeleteOfferPromise(userUid, offer));
		});
	}

    return Promise.all(deleteOfferPromiseArray);
}

// Delete offer
function getDeleteOfferPromise(userUid, offer) {
	let offerUid = offer.offer_uid;
	
	return getDeleteOfferReviewsPromise(userUid, offerUid, deleteCollectionBatchSize)
		.then(() => {
			deleteOfferPhotos(userUid, offer);
			return;
		});
}

// Delete offer reviews collection in batches
function getDeleteOfferReviewsPromise(userUid, offerUid, batchSize) {
	return deleteCollection(`reviews/${userUid}_${offerUid}/reviewsOfOffer`, batchSize);
}

// Delete offer photos, if exist
function deleteOfferPhotos(userUid, offer) {
	let offerPhotoList = offer.offer_photo_list;
	deletePhotos(userUid, offerPhotoList, 'offer_photos');
}

// Delete photos, if photo list exists and not empty
function deletePhotos(userUid, photoList, photoFolderName) {
	if (photoList !== undefined) {
		photoList.forEach((photo) => {
			let photoUid = photo.photoUid;
			bucket.file(`${userUid}/${photoFolderName}/${photoUid}.jpg`).delete();
		});
	}
}

// Delete offer rating list item for offer being deleted
function deleteOfferRatingListItem(userUid, offerUid) {
	const providerUserRef = firestore.collection('users').doc(userUid);

  	// Update provider user offer rating list in transaction
  	// (this is needed, because another user can leave a review on the same offer at the same time)
    return firestore.runTransaction(transaction => {
	    return transaction.get(providerUserRef)
			.then(doc => {
				// Get provider user
 	   	        let providerUser = doc.data();

			  	// Get offer rating list
			  	let offerRatings = providerUser.offerRatingList;

			  	if (offerRatings === undefined) {
			  		// If user has no reviews yet, do nothing
			  		return null;
			  	
			  	} else {
			  		// Otherwise remove corresponding offer rating list item

				  	// Find index of current offer's rating
				  	const index = offerRatings.findIndex( item => item.offer_uid === offerUid );

				  	if (index >= 0 && index < offerRatings.length) {
						// Remove current offer's rating, if exists
			   			offerRatings.splice(index, 1);

			            // Update only offer rating array in provider user
						const updatedProviderUser = {
							offerRatingList: offerRatings
						};

						return transaction.update(providerUserRef, updatedProviderUser);

				  	} else {
				  		// Otherwise do nothing 
				  		// (there is no item for current offer in offer rating list, 
				  		// because offer has no reviews).
				  		return null;
				  	}
			  	}
	    	})
	})
	.then(result => {
		return null;
	})
	.catch(err => {
		console.log('Update provider user transaction failure:', err);
		return null;
	});	
}