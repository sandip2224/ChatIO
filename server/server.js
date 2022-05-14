const express = require('express')
const path = require('path')
const http = require('http')
const colors = require("colors")
const socketio = require('socket.io')
const webpush = require('web-push')
require("dotenv").config({ path: "./.env" })

const formatMessage = require('../client/utils/messages')
const { userJoin, getCurrentUser, userLeave, getRoomUsers } = require('../client/utils/users')
const connectDB = require('./config/db')
const chatModel = require('./models/Chat')

const app = express()
const server = http.createServer(app)
const io = socketio(server)

const vapidKeys = {
	publicKey: 'BO_DeYGvxJZ8SfL16UDMlW2XSzXLRldLOjv11Cv1BhDyAiMBoTKZ3uMS6jcuj52z4X5C53BIxQN1dcjy4cVRxHY',
	privateKey: process.env.PRIVATE_KEY
}

let subscriptions = []

webpush.setVapidDetails('mailto:test@test.com', vapidKeys.publicKey, vapidKeys.privateKey)

connectDB()

app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, '../client/views'));

app.use(express.urlencoded({ extended: false }))
app.use(express.json())

app.use(express.static(path.join(__dirname, '../client/public')))
app.use('/', require('./routes/chatRoute'))

const userExists = (reqBodyItems) => {
	return subscriptions.some(item =>
		item.subscription.endpoint === reqBodyItems.subscription.endpoint && item.name === reqBodyItems.name && item.room === reqBodyItems.room
	)
}

const filteredUsers = (reqBodyItems) => {
	return subscriptions.filter(item => {
		return !(item.subscription.endpoint === reqBodyItems.subscription.endpoint && item.name === reqBodyItems.name && item.room === reqBodyItems.room)
	})
}

const exitFilteredUsers = (user) => {
	return subscriptions.filter(item => {
		return !(item.name === user.username && item.room === user.room)
	})
}

// Push notification endpoints BEGIN

app.post('/register-push-device', (req, res) => {
	var flag = userExists(req.body)
	if (!flag) {
		subscriptions.push({
			subscription: req.body.subscription,
			name: req.body.name,
			room: req.body.room
		})
	}
	console.log(subscriptions)
	console.log("Subscriptions list length: ", subscriptions.length)
	res.end()
})

app.delete('/deregister-push-device', (req, res) => {
	console.log('Unregistering user subscription...')
	subscriptions = filteredUsers(req.body)
	console.log("Modified subscriptions list length: ", subscriptions.length)
	res.end()
})

app.post('/send-notification', (req, res) => {
	const notifBody = {
		msg: req.body.msg.text,
		user: req.body.msg.username
	}
	console.log('Sending notification: ', notifBody)
	subscriptions.forEach((item) => {
		if (item.room === req.body.msg.room && item.name === req.body.username) {
			webpush.sendNotification(item.subscription, JSON.stringify(notifBody)).catch(error => {
				console.error(error)
			})
		}
	})
	res.end()
})

// Push notification endpoints END

// Run when client connects
io.on('connection', (socket) => {
	socket.on('joinRoom', ({ username, room }) => {
		const user = userJoin(socket.id, username, room)

		// Pushes a user socket to the given room
		socket.join(user.room)

		// Welcome adminMessage for client alone who connects
		socket.emit('message', formatMessage('Admin', `Welcome to ChatIO ${user.username}!!`))

		// Broadcast to everyone else when user connects
		socket.broadcast.to(user.room).emit('message', formatMessage('Admin', `${user.username} has joined the chat!!`))

		// Triggered during keypress event on client side
		socket.on('starttype', (msg) => {
			socket.broadcast.to(user.room).emit('type', msg)
		})

		socket.on('stoptype', (msg) => {
			socket.broadcast.to(user.room).emit('type', msg)
		})

		// Send users and room info to every client in a room
		io.to(user.room).emit('roomUsers', {
			room: user.room,
			users: getRoomUsers(user.room)
		})
	})

	// Listen for chat message from client
	socket.on('chatMessage', async (msg) => {
		const user = getCurrentUser(socket.id)
		const frmtMsg = formatMessage(user.username, msg, user.room)
		const obj = {
			username: `${frmtMsg.username}`,
			time: `${frmtMsg.time} (${frmtMsg.date})`,
			message: `${frmtMsg.text}`,
			room: `${user.room}`
		}
		const newMsg = new chatModel(obj)
		await newMsg.save()
		io.to(user.room).emit('message', frmtMsg)
	})

	// Run when client disconnects
	socket.on('disconnect', () => {
		const user = userLeave(socket.id)
		if (user) {
			subscriptions = exitFilteredUsers(user)
			console.log(`Successfully unsubscribed ${user.username} from room ${user.room} notifications`)
			io.to(user.room).emit('message', formatMessage('Admin', `${user.username} has left the chat`))
			// Send users and room info to every client
			io.to(user.room).emit('roomUsers', {
				room: user.room,
				users: getRoomUsers(user.room)
			})
		}
	})
})

const conn = server.listen(process.env.PORT || 3000, console.log(`Server running on port ${process.env.PORT || 3000}`))

// Handle unhandled promise rejections
process.on("unhandledRejection", (err, promise) => {
	console.log(`Error: ${err.message}`.red)
	conn.close(() => process.exit(1))
})