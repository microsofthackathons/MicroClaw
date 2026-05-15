OpenClaw + MS Teams + Free Tokens 

 

How to get free tokens 

There are two options available (personal account / work account), and you only need to select one (recommend Work account, as it does not have a token limit and requires less manual effort): 

Personal account 

MS provides $150 credit for every FTE to use Azure.  Please hookup this offer with your personal account (not work account), and login Azure to create Azure OpenAi resource and deploy a model via foundry portal 

 

Then follow this  blog 

Integrating Microsoft Foundry with OpenClaw: Step by Step Model Configuration | Microsoft Community Hub 

Testing  

 

Work Account 

Open VS code and install extension Agent Maestro 

Set up Claude Code settings in Agent Maestro (you will be prompted to set up models to use) 

Open C:\Users\{alias} \.claude\settings.json to get the ANTHROPIC_BASE_URL config looks like: 

 

Fill the models.providers.maestro.baseUrl with this url in C:\Users\{alias}\.openclaw\openclaw.json (this json will be generated after you install openclaw): 

  "models": { 

    "providers": { 

      "maestro": { 

        "baseUrl": "http://localhost:23333/api/anthropic/v1", 

        "apiKey": "dummy", 

        "api": "anthropic-messages", 

        "models": [ 

          { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6 (Agent Maestro)" } 

        ] 

      } 

    } 

  }, 

  "agents": { 

    "defaults": { 

      "model": { 

        "primary": "maestro/claude-sonnet-4-6" 

      }, 

      "workspace": "C:\\Users\\chuzha\\.openclaw\\workspace", 

      "compaction": { 

        "mode": "safeguard" 

      }, 

      "maxConcurrent": 4, 

      "subagents": { 

        "maxConcurrent": 8 

      } 

    } 

  } 

Make sure the vs code is open and claude code works when you use openclaw 

Create Azure Bot 

Microsoft Teams - OpenClaw has provided instructions as below to create azure bot. but this is not enough.  

 

You need to go the configuration/channels to enable MS teams 

 

 

 

Install Openclaw on windows and MS teams plugin 

Following openclaw homepage instructions, there are some tricks. Basically you need to do 

Install Powershell, and open it as admin 

Run command line “Set-ExecutionPolicy RemoteSigned -Scope CurrentUser” and select “Y” to get permission 

Run command line “iwr -useb https://openclaw.ai/install.ps1 | iex” 

Or you can follow official page Getting Started - OpenClaw 

Please note when you configure channels, please select MS teams, it will install the extension for you.  You can follow through with the default configuration as you can later change them.  

Openclaw current installation is not friendly to Teams setup.  

Please open your openclaw directory and for example my directory is C:\Users\jilong.FAREAST\.openclaw> 

Find its configuration file openclaw.json 

You need to edit this file under channel section  

 

You need to find appID, tenantID from your Azure Bot configuration 

 

 

The appPassword can be generated from clicking “Manage Password”. Remember you need to generate a new one by clicking “New client secrete” and copy the value (not the secrete id) 

 

Change “dmPolicy” and “allowFrom” as the screenshot above. 

 

Setup webhook 

You need to install ngrok 

Create a new Powershell window 

Run “winget install ngrok.ngrok” 

You also new to login the home page of ngrok to get authorized. You can get authorized via your github account. From the login page you will get a token like this 

 

Copy and paste the command line and run in your powershell window 

Then run “ngrok update” 

Then run “ 

” 

You can see something like this 

 

Copy the generated url to the configuration of the azure bot you created. Don’t forget to append api/messages  

 

Do not  shut down ngrok window, this url is temp because it is free and should exist while your openclaw is running. If you shut it down, you need to regenerate the url and rebind it with message endpoint of your azure bot 

Test it on azure using test in web chat 
 

If you can see a reply like above or your ngrok window has message like. It is good.  
 
 

Otherwise, something is not right. 

 

Create MS Teams App 

In general, you need to follow openclaw instructions at Microsoft Teams - OpenClaw  

 

But the default instructions are not enough. 

 

In Binding, you need to strictly follow the instructions to create the icons. I suggest you use chatgpt to create png files for your icons especially the outline icon. 

 

You also need to go to  

App package editor to edit manifest file 

 

By adding  "supportsChannelFeatures": "tier1" 

 

 

 

Saving everything so far. Click  

Click Preview, you should be able to see your bot in teams.  

FAQ 

Q: Encounter 502 Bad Gateway when testing in web chat 

 

 

 

A: cd <openclaw-install-path>/node_modules/openclaw 

npm install \ 

  @microsoft/agents-hosting \ 

  @microsoft/agents-hosting-express \ 

  @microsoft/agents-hosting-extensions-teams 

 

OpenAI embedding quota exhausted 

You can use local mode based on the suggestions: 

 

 

Use embeddings API of OpenAI 

Add following under agents.defaults in openclaw.json 

 

"memorySearch": { 

        "provider": "openai", 

        "model": "text-embedding-3-small", 

        "remote": { 

          "baseUrl": "https://<your-resource>.openai.azure.com/openai/v1/", 

          "apiKey": "xxx" 

        } 

  } 

 

You can find baseUrl/apiKey on Microsoft Foundry 

 

 

For model name, please deploy embedding model first 

 

 

Then restart openclaw gateway. 