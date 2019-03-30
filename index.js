/**
 * A Bot for Slack!
 * The Gossip bot will broadcast anything she hears
 * to listeners on the listenerPort
 */

require('dotenv').config();

/**
 * Define a function for initiating a conversation on installation
 * With custom integrations, we don't have a way to find out who installed us, so we can't message them :(
 */

function onInstallation(bot, installer) {
    if (installer) {
        bot.startPrivateConversation({user: installer}, function (err, convo) {
            if (err) {
                console.log(err);
            } else {
                convo.say('I am a bot that has just joined your team');
                convo.say('You must now /invite me to a channel so that I can be of use!');
            }
        });
    }
}


/**
 * Configure the persistence options
 */

var config = {};
if (process.env.MONGOLAB_URI) {
    var BotkitStorage = require('botkit-storage-mongo');
    config = {
        storage: BotkitStorage({mongoUri: process.env.MONGOLAB_URI}),
    };
} else {
    config = {
        json_file_store: ((process.env.TOKEN)?'./db_slack_bot_ci/':'./db_slack_bot_a/'), //use a different name if an app or CI
    };
}

/**
 * Are being run as an app or a custom integration? The initialization will differ, depending
 */

if (process.env.TOKEN || process.env.SLACK_TOKEN) {
    //Treat this as a custom integration
    var customIntegration = require('./lib/custom_integrations');
    var token = (process.env.TOKEN) ? process.env.TOKEN : process.env.SLACK_TOKEN;
    var controller = customIntegration.configure(token, config, onInstallation);
} else if (process.env.CLIENT_ID && process.env.CLIENT_SECRET && process.env.PORT) {
    //Treat this as an app
    var app = require('./lib/apps');
    var controller = app.configure(process.env.PORT, process.env.CLIENT_ID, process.env.CLIENT_SECRET, config, onInstallation);
} else {
    console.log('Error: If this is a custom integration, please specify TOKEN in the environment. If this is an app, please specify CLIENTID, CLIENTSECRET, and PORT in the environment');
    process.exit(1);
}


/**
 * A demonstration for how to handle websocket events. In this case, just log when we have and have not
 * been disconnected from the websocket. In the future, it would be super awesome to be able to specify
 * a reconnect policy, and do reconnections automatically. In the meantime, we aren't going to attempt reconnects,
 * WHICH IS A B0RKED WAY TO HANDLE BEING DISCONNECTED. So we need to fix this.
 *
 * TODO: fixed b0rked reconnect behavior
 */
// Handle events related to the websocket connection to Slack
controller.on('rtm_open', function (bot) {
    console.log('** The RTM api just connected!');
});

controller.on('rtm_close', function (bot) {
    console.log('** The RTM api just closed');
    // you may want to attempt to re-open
});


/**
 * Core logic
 */

//const http = require('http');
const express = require('express');
const localApp = express();
const net = require('net');
const fs = require('fs');
const color = require('colors');
const listenerPort =  process.env.LISTENERPORT;
const httpPort =  process.env.HTTPPORT;

const util = require('util');
let listenerID = 0;
const listeners = {};


//sets up authenticatedUsers
fs.readFile('.users', function(err, data) {
    if(err){
      fs.open('.users','w', function(err, file){
        if(err) throw err;
        console.log(".users file created");
      });
      data = "";
    };
    controller.authenticatedUsers = data.toString().split("\n");
});

localApp.get('/', function(req, res) {
     res.sendFile(__dirname + '/index.html');
 });

localApp.listen(httpPort, function () {
     console.log(`http listening on port: ${httpPort}`.yellow)
 });

const netServer = net.createServer(function(socket) {
    socket.setNoDelay(true);

    socket.nickname = "net#"+listenerID++;
    socket.status = "running";

    const clientName = socket.nickname;
    listeners[clientName] = socket;

    console.log(`${clientName} has joined`);

    socket.on('error', function(ex) {
        console.log(`${clientName} has disconnected abruptly`.red);
        //console.log(ex);
    });

    socket.on('pause',function(){
        socket.status = "paused";
        console.log(`${clientName} is paused`);
    });

    socket.on('resume',function(){
        socket.status = "running";
        console.log(`${clientName} is running`);
    });

    socket.addListener("close", function(){
        console.log(`${clientName} has disconnected gracefully`);
        delete listeners[clientName];
    });

}).listen(listenerPort, function () {
    netServer.status='listening';
    netServer.port = listenerPort;
});



netServer.broadcast = function broadcast(message) {
    let send = [];
    if(typeof message === "string"){
        send = message.split("\n");
    } else if(typeof message === "object"){
        message.text.split("\n").forEach(function(line){
           send.push(`${message.channel},${message.user},${line}`)
        });
    }

    Object.keys(listeners).forEach(function (user) {
        if(listeners[user].status === "running"){
            send.forEach(function(line){
                listeners[user].write(line+'\n');
            });
        }
    });

    send.forEach(function(line){
        console.log(line);
    });

};

controller.isAuthenticated = function isAuthenticated(user){
  return controller.authenticatedUsers.includes(user);
};

controller.authenticatedTask = function authenticatedTask(bot, message, task){
    if(controller.isAuthenticated(message.user)){
        task(bot,message);
    } else {
        bot.reply(message, "You'll need to be authenticated first. type 'authenticate' to continue")
    }
};

//['message_received', 'direct_mention', 'mention', 'ambient', 'direct_message']
controller.commands = {
    authenticate : {
        commandList: ['authenticate'],
        description: "Authenticate into the system"
    },
    options : {
        commandList: ['options'],
        description: "Get a list of all availale commands"
    },
    status : {
        commandList: ['status'],
        description: "Get Status of external connections"
    },
    endAll : {
        commandList: ['end-all'],
        description: "End all of the current connections"
    },
    pauseAll : {
        commandList: ['pause-all'],
        description: "Pause all connections"
    },
    resumeAll : {
        commandList: ['resume-all'],
        description: "Resume all of the currently paused connections"
    },
    closeServer : {
        commandList: ['close-server'],
        description: "Close the server"
    },
    openServer : {
        commandList: ['open-server'],
        description: "Open the server"
    }
}

Object.keys(controller.commands).forEach(function(command){
    controller.commands[command].commandChannels = ['direct_message','message_received'];
});


controller.hears(
    controller.commands.authenticate.commandList,
    controller.commands.authenticate.commandChannels,
    function(bot,message){
        if(!controller.isAuthenticated(message.user)){ //check for authenticated here
            bot.createConversation(message, function(err,convo){
                // create a path for when a user knows the password
                convo.addMessage({
                    text: "Roger, you're in!",
                },'good_password');

                // create a path for when a user says YES
                convo.addMessage({
                    text: 'Are you trying to get me fired?',
                },'bad_password');

                convo.addQuestion("What's the password?",[
                    {
                        pattern: process.env.PASSWORD,
                        callback: function(response, convo){
                            controller.authenticatedUsers.push(message.user);
                            convo.gotoThread('good_password');
                            fs.appendFile('.users', message.user+'\n', function (err) {
                                if (err) throw err;
                                console.log('Updated User list!');
                            });
                        }
                    },
                    {
                        default: true,
                        callback: function(response, convo){
                            convo.gotoThread('bad_password');
                        }
                    }
                ],{},'default');
                convo.activate();
            });
        } else {
            bot.reply(message, "You're already authenticated!");
        }
    }
);

controller.hears(
    controller.commands.status.commandList,
    controller.commands.status.commandChannels,
    function(bot,message) {
        controller.authenticatedTask(bot,message, function(bot,message){
            const users = Object.keys(listeners);
            let outMessage = `Listener Port: ${netServer.port}`
            outMessage += `\nServer Status: ${netServer.status}`
            outMessage += `\nCurrent Connections: ${users.length}`
            users.forEach(function (user) {
                outMessage += `\n\t${user} is ${listeners[user].status}`
            });
            bot.reply(message, outMessage);
        })
    }
);

controller.hears(
    controller.commands.options.commandList,
    controller.commands.options.commandChannels,
    function(bot,message) {
        let outMessage = "Command List:";
        let commands = [];

        if(controller.isAuthenticated(message.user)) {
            commands = Object.keys(controller.commands);
        } else {
            commands = ["options","authenticate"];
        }

        commands.forEach(function(command){
            outMessage += `\n\t${controller.commands[command].commandList.join(", ")} : ${controller.commands[command].description}`;
        });

        bot.reply(message, outMessage);
    }
);

controller.hears(
    controller.commands.endAll.commandList,
    controller.commands.endAll.commandChannels,
    function(bot,message) {
        controller.authenticatedTask(bot,message, function(bot,message){
            const users = Object.keys(listeners);
            let count = 0;

            users.forEach(function (user, index) {
                listeners[user].end();
                count++;
            });

            bot.reply(message, `Clients Terminated: ${count}`);
        });
    }
);

controller.hears(
    controller.commands.pauseAll.commandList,
    controller.commands.pauseAll.commandChannels,
    function(bot,message) {
        controller.authenticatedTask(bot,message, function(bot,message){
            const users = Object.keys(listeners);

            users.forEach((user) => {
                if(listeners[user].status === 'running') {
                    listeners[user].pause();
                }
            });

            bot.reply(message, `Clients Paused: ${users.length}`);
        });
    }
);

controller.hears(
    controller.commands.resumeAll.commandList,
    controller.commands.resumeAll.commandChannels,
    function(bot,message) {
        controller.authenticatedTask(bot,message, function(bot,message){
            const users = Object.keys(listeners);
            let count = 0;

            users.forEach((user) => {
                if(listeners[user].status === 'paused'){
                    listeners[user].resume();
                    count++;
                }
            });
            bot.reply(message, `Clients Resumed: ${count}`);
        });
    }
);

controller.hears(
    controller.commands.closeServer.commandList,
    controller.commands.closeServer.commandChannels,
    function(bot,message) {
        controller.authenticatedTask(bot,message, function(bot,message){
            if(netServer.status === 'listening'){
                if(Object.keys(listeners).length > 0){
                    netServer.status = 'closing';
                    bot.reply(message,"Attempting to Close Server");
                    bot.reply(message,"Server will remain open until all listeners disconnect");
                    bot.reply(message,"Hint: telling me to 'end-all' should end it now");
                }
                netServer.close(function(){
                    bot.reply(message,"Server Successfully closed");
                    netServer.status='closed';
                });
            } else if(netServer.status === 'closed') {
                bot.reply(message,"Can't close a closed Server");
            } else if(netServer.status === 'closing'){
                bot.reply(message,"Server is already closing.  It will close after all listeners disconnect.");
                bot.reply(message,"Hint: you can tell me to 'end-all' to close all the listeners");
            } else {
                bot.reply(message,`Server in a weird state: ${netServer.status}`);
            }
        });
    }
);

controller.hears(
    controller.commands.openServer.commandList,
    controller.commands.openServer.commandChannels,
    function(bot,message) {
        controller.authenticatedTask(bot,message, function(bot,message){
            if(netServer.status === 'closed'){
                netServer.listen(listenerPort,function(){
                    bot.reply(message,"Server Successfully opened");
                    netServer.status='listening';
                });
            } else if(netServer.status === 'listening') {
                bot.reply(message,"Can't open an open Server");
            } else if(netServer.status === 'closing') {
                bot.reply(message,"Server is currently closing.  It will close after all listeners disconnect.");
                bot.reply(message,"Hint: you can tell me to 'end-all' to close all the listeners and then 'open-server' to open properly");
            } else {
                bot.reply(message,`Server in a weird state: ${netServer.status}`);
            }
        });
    }
);

controller.hears(
    ['.*'], //regex for message found
    ['ambient'], //ambient is any message not directed at the bot
    function(bot,message) {
        const output = {
            channel:`${message.channel}`,
            user:`${message.user}`,
            text:`${message.text}`
        }
        netServer.broadcast(output);
        // bot.say(
        //     {
        //         text: 'I heard that',
        //         channel: 'DE84G07JA' // a valid slack channel, group, mpim, or im ID
        //     });
    }
);

console.log(`Waiting for flink on: ${listenerPort}`.yellow);


/**
 * AN example of what could be:
 * Any un-handled direct mention gets a reaction and a pat response!
 */
//controller.on('direct_message,mention,direct_mention', function (bot, message) {
//    bot.api.reactions.add({
//        timestamp: message.ts,
//        channel: message.channel,
//        name: 'robot_face',
//    }, function (err) {
//        if (err) {
//            console.log(err)
//        }
//        bot.reply(message, 'I heard you loud and clear boss.');
//    });
//});
