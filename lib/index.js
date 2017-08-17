var fs = require('fs');
var url = require('url');
var os = require('os');
var stream = require('stream');

var vasync = require('vasync');
var manta = require('manta');
var moment = require('moment');
var colors = require('colors/safe');
var handlebars = require('handlebars');
var JiraClient = require('jira-client');
var request = require('request');

var CONFIG = require('../etc/config.json');

var ID = process.argv[2].toUpperCase();

var mailer = require('nodemailer')
  .createTransport(CONFIG.nodemailer.smtpTransport);

var readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });

var jira = new JiraClient({
    protocol: 'https:',
    host: process.env.JIRA_DOMAIN,
    username: process.env.JIRA_USER,
    password: process.env.JIRA_PASS,
    base: process.env.JIRA_PATH,
    apiVersion: '2',
    strictSSL: true
  });

var mclient = manta.createClient({
    sign: manta.privateKeySigner({
        key: CONFIG.MANTA_PRIVATE_KEY ||
          fs.readFileSync(CONFIG.MANTA_KEY_MATERIAL, 'utf8'),
        keyId: CONFIG.MANTA_KEY_ID,
        user: CONFIG.MANTA_USER,
        subuser: CONFIG.MANTA_SUBUSER
    }),
    user: CONFIG.MANTA_USER,
    subuser: CONFIG.MANTA_SUBUSER,
    url: CONFIG.MANTA_URL
  });

// Compile handlebar templates
var template = {};
for (var i = 0; i < CONFIG.templates.length; i++) {
  var tpl = CONFIG.templates[i];
  template[tpl] = {
    txt: handlebars
      .compile(fs.readFileSync(CONFIG.templatePath + tpl + '.txt')
      .toString()),
    html: handlebars
      .compile(fs.readFileSync(CONFIG.templatePath + tpl + '.html')
      .toString())
  };
}

function OK(what, msg) {
  console.log(colors.black.bgGreen(' ✓ '), colors.bold(what) + ':', msg);
}

function FAIL(what, msg) {
  console.error(colors.black.bgRed(' ✕ '), colors.bold(what) + ':', msg);
}

function WARN(what, msg) {
  console.error(colors.black.bgYellow(' → '), colors.bold(what) + ':', msg);
}

// add a leading space to the text output
function lpad(txt) {
  return ' ' + txt.split('\n').join('\n ');
}

// combined fields for status.io incident details
function incidentDetails(ctx) {
  var details = '\r\n' + 
    'CURRENT STATUS:\r\n' + 
      ctx.current_status_txt + '\r\n' +
    '\r\nIMPACT:\r\n' +
      ctx.impact_txt + '\r\n';

  if (!ctx.resolved) {
    details += '\r\nRESOLUTION ACTIONS:\r\n' + 
      ctx.resolution_actions_txt;
  }

  return details + '\r\n\r\n' + 'Internal ID: ' + ctx.ID;
}

// Fetch JIRA then transform and render the notices, everything is stored in ctx
function getJIRAByID(next) {
  jira
    .findIssue(ID)
    .then(function(issue) {
      var project = ID.split('-')[0];
      var conf = CONFIG[project];

      if (!conf) {
        // Each JIRA project needs its own sub-configuration in the config.json
        // see "SCI": {...} in config.json as an example.
       return next(new Error('Unsupported JIRA project:' + project));
      }

      var ctx = {
        ID: ID,
        project: project,
        conf: conf,
        summary: issue.fields.summary,
        cloud: conf.CLOUD,
        jira: 'https://' + process.env.JIRA_DOMAIN + '/' + process.env.JIRA_PATH,
        issue: issue.fields,
        current_status_txt: lpad(issue.fields[conf.STATUS]),
        current_status: issue.fields[conf.STATUS],
        impact: issue.fields[conf.CURRENT_IMPACT],
        impact_txt: lpad(issue.fields[conf.CURRENT_IMPACT]),
        resolution_actions: issue.fields[conf.RESOLUTION_ACTIONS],
        resolution_actions_txt: lpad(issue.fields[conf.RESOLUTION_ACTIONS]),
        details: {
          priority: issue.fields.priority.name,
          root_cause: issue.fields[conf.ROOT_CAUSE],
          incident_start_time: moment(issue.fields[conf.START])
            .utc().format(conf.DATE_FORMAT),
          incident_end_time: moment(issue.fields[conf.END])
            .utc().format(conf.DATE_FORMAT),
          incident_duration: issue.fields[conf.DURATION],
          incident_description: issue.fields.description,
          incident_status: issue.fields.status.name,
          issue_type: issue.fields.issuetype.name,
          incident_manager: (issue.fields.assignee) ?
            issue.fields.assignee.displayName : null
        },
        msg: {
          from: CONFIG.nodemailer.sender
        },
        statusio: {
          headers: {
            'x-api-id': process.env.STATUS_API_ID,
            'x-api-key': process.env.STATUS_API_TOKEN
          }
        }
      };

      // Create comma separated list of impacted Locations
      if (issue.fields[conf.LOCATION]) {
        ctx.details.location = '';
        for (var i = 0; i < issue.fields[conf.LOCATION].length; i++) {
          ctx.details.location += issue.fields[conf.LOCATION][i].value + ' ';
        }
      } else {
        ctx.details.location = 'None';
      }

      if (!issue.fields[conf.ESCALATION_LEVEL]) {
        return next(new Error('No Escalation Level defined for ' + ID));
      }

      ctx.msg.to = conf.ESCALATION_RECIPIENTS[issue.fields[conf.ESCALATION_LEVEL].value];
      ctx.msg.subject = 'Incident Alert: ' +  ID + ' - ' + issue.fields.summary;

      if (issue.fields.status.name === 'Resolved') {
        ctx.resolved = true;
        ctx.msg.subject = '[Resolved] ' + ctx.msg.subject;
      }

      // Render handlebar templates
      ctx.msg.txt = template.internal_initial.txt(ctx);
      ctx.msg.html = template.internal_initial.html(ctx);

      next(null, ctx);

  }).catch(function(err) {
    console.error(err.message || err);
    next(new Error('Unable to retrieve JIRA: ' + ID));
  });
}

function previewNotice(ctx, next) {
  console.log('To: ' + ctx.msg.to);
  console.log('Subject: ' + ctx.msg.subject);
  console.log(ctx.msg.txt);
  next(null, ctx);
}

function confirmPreview(ctx, next) {
  readline.question('Send notification? [Y/n] ', function (answer) {
    if (answer !== 'Y') {
      return next('Email not sent. Please enter "Y" to send.');
    }
    next(null, ctx);
  });
}

function sendNotice(ctx, next) {
  mailer.sendMail(ctx.msg, function (err, ok) {
    if (err || !ok) {
      console.error(err);
      return next(new Error('Could not send email'));
    }
    OK('Email', 'Sent. ' + ok.response);
    next(null, ctx);
  });
}

// Update the "Last Internal Notice" and "External Notice Link" fields
function updateJIRA(ctx, next) {
  var update = {fields: {}};
  var now = moment().utc().format(CONFIG.JIRA_DATE_FORMAT);
  update.fields[ctx.conf.LAST_INTERNAL_NOTICE] = now;

  if (ctx.statusio.create) {
    update.fields[ctx.conf.EXTERNAL_LINK] = ctx.statusio.extLink;
  }

  jira
    .updateIssue(ctx.ID, update)
    .then(function () {
      OK('JIRA', '"Last Internal Notice" field updated.');
      if (ctx.statusio.create) {
        OK('JIRA', '"External Notice Link" added.');
      }
      next(null, ctx);
    })
    .catch(function(err) {
      console.error(now, err.message || err);
      next(new Error('Last Internal Notice field not updated.'));
    });
}

// Attach the text rendered email to the JIRA as a comment.
function addCommentToJIRA(ctx, next) {
  var comment = 'Notices sent.\n' +
    '{noformat}\n' + ctx.msg.txt + '\n{noformat}';
  jira
    .addComment(ctx.ID, comment)
    .then(function () {
      OK('JIRA', 'Comment added with notice details.');
      next(null, ctx);
    })
    .catch(function(err) {
      console.error(err.message || err);
      next(new Error('Unable to add comment to JIRA.'));
    });
}

// setup ctx.statusio object and determine if there is already a 
// status.io notice to update or if a new one needs to be created.
function checkStatusNotice(ctx, next) {
  if (ctx.conf.SKIP_STATUS) {
    return next(null, ctx);
  }
  var extLink = url.parse(ctx.issue[ctx.conf.EXTERNAL_LINK] || '');
  if (extLink.protocol) {
      ctx.statusio.incID = extLink.path.split('/').pop();
      if (ctx.statusio.incID) {
        ctx.statusio.update = true;
      } else {
        FAIL('Status.io', 'The JIRA has an invalid "External Notice Link".');
        console.error('Continuing, but no actions will be taken on Status.io');
      }
  } else {
      ctx.statusio.create = true;
  }
  ctx.statusio.status = (ctx.resolved) ?
    100 : ctx.conf.IMPACT[ctx.issue[ctx.conf.INCIDENT_IMPACT].value];
  next(null, ctx);
}

// If you delete the status.io notice without removing the link on the JIRA or 
// if the link is invalid for some other reason Status.io returns an auth error
// instead of something useful so this function attempts to fetch the incident
// before updating it later on. 
function sanityCheckStatusNotice(ctx, next) {
  if (!ctx.statusio.update) {
    return next(null, ctx);
  }
  request.get({
    url: process.env.STATUS_URL + 'incident/list/' + ctx.conf.STATUS_PAGE_ID,
    json: true,
    headers: ctx.statusio.headers
  }, function (err, httpResponse, body) {
      if (err || body.status.error === 'yes') {

        ctx.statusio.update = false;
        ctx.statusio.create = false;
        FAIL('Status.io', err || body);
        console.error('Continuing, but no actions will be taken on Status.io');
        return next(null, ctx);
      }

      // If we're updating an incident confirm it is listed in active_incidents
      for (var i = 0; i < body.result.active_incidents.length; i++) {
        if (body.result.active_incidents[i]._id === ctx.statusio.incID) {
          return next(null, ctx);
        }
      }

      FAIL('Status.io', 'The JIRA has an "External Notice Link" but it ' + 
        'could not be found on Status.io.');
      console.error('Continuing, but no actions will be taken on Status.io');

      ctx.statusio.update = false;

      next(null, ctx);
  });
}

function createStatusNotice(ctx, next) {
  if (!ctx.statusio.create) {
    return next(null, ctx);
  }

  // If there's not an existing status.io incident and the issue is resolved, 
  // we probably need to create a historical incident. This is not yet supported.
  if (ctx.resolved === true) {
    FAIL('Status.io', 'im-notices does not yet support historical incidents.');
    console.error('The JIRA is Resolved, but there is no existing status.io ' + 
      'incident attached to the JIRA.');
    console.error('You will need to create a historical incident manually.');
    console.error('Continuing, but no actions will be taken on Status.io');
    ctx.statusio.create = false;
    return next(null, ctx);
  }

  var component = ctx.conf.COMPONENT[ctx.issue.issuetype.name];
  var location = ctx.issue[ctx.conf.LOCATION];
  var containers = [];

  for (var i = 0; i < location.length; i++) {
    containers.push(ctx.conf.CONTAINER[location[i].value]);
  }

  var requestBody = {
    statuspage_id: ctx.conf.STATUS_PAGE_ID,
    components: [component],
    containers: containers,
    incident_name: ctx.summary,
    incident_details: incidentDetails(ctx),
    notify_email: "0",
    notify_sms: "0",
    notify_webhook: "0",
    social: "0",
    current_status: ctx.statusio.status,
    current_state: 100, // 100 = Investigating
    all_infrastructure_affected: "0"
  };

  request.post({
    url: process.env.STATUS_URL + 'incident/create',
    headers: ctx.statusio.headers,
    json: requestBody
  }, function (err, httpResponse, body) {
      if (err) {
          return next(err);
      }
      if (body.status && body.status.error === 'yes') {
        FAIL('Status.io', body.status.message);
        console.error('Continuing, but a notice was not posted on status.io');
        console.error('Please report this error.', body);
        ctx.logErrors = {issue: ctx.issue, request: requestBody};
      } else {
        ctx.statusio.extLink = ctx.conf.INC_URL + ctx.conf.STATUS_PAGE_ID +
          '/' + body.result;
        OK('Status.io', 'Notice posted: ' + ctx.statusio.extLink);
      }
      next(null, ctx);
  });
}

function updateStatusNotice(ctx, next) {
  if (!ctx.statusio.update) {
    return next(null, ctx);
  }
  var endpoint = 'incident/update';
  var requestBody = {
    statuspage_id: ctx.conf.STATUS_PAGE_ID,
    incident_id: ctx.statusio.incID,
    incident_details: incidentDetails(ctx),
    notify_email: "0",
    notify_sms: "0",
    notify_webhook: "0",
    social: "0",
    all_infrastructure_affected: "0"
  };

  // It's a separate endoint, with less properties to resolve an incident.
  if (ctx.resolved === true) {
    endpoint = 'incident/resolve';
  } else {
    requestBody.current_status = ctx.statusio.status;
    // We always use 100 (Investigating) for the state since we provide 
    // detailed action updates throughout the duration of an incident.
    requestBody.current_state = 100;
  }

  request.post({
    url: process.env.STATUS_URL + endpoint,
    headers:  ctx.statusio.headers,
    json: requestBody,
  }, function (err, httpResponse, body) {
    if (err) {
      return next(err);
    }
    if (body.status && body.status.error === 'yes') {
      FAIL('Status.io', body.status.message);
    } else {
      OK('Status.io', 'Notice updated.');
    }
    ctx.statusio.extLink = ctx.conf.INC_URL + ctx.conf.STATUS_PAGE_ID +
      '/' + body.result;
    next(null, ctx);
  });
}

function saveMantaLog(ctx, next) {
  var path = CONFIG.MANTA_UPLOAD_PATH +
      moment().format('YYYYMMDD/HHmm.ss') +
      '_' + os.hostname() + '.log';
  var input = new stream.Readable();

  ctx.msg.details = ctx.details;
  ctx.msg.datetime = moment().format();
  ctx.msg.errors = ctx.logErrors || null;

  var logContent = JSON.stringify(ctx.msg, null, 4);

  input.push(logContent);
  input.push(null);

  mclient.put(path, input, {mkdirs: true}, function (err) {
      if (err) {
        path = CONFIG.MANTA_LOCAL_FALLBACK_PATH + 'im-notices.' +
          moment().format('YYYYMMDD-HHmm.ss') + '_localhost.log';
        fs.writeFileSync(path, logContent);
        console.error('Local file saved at: ' + path);
        console.error(err.message || err);
        return next(new Error('Unable to write log to Manta ' + path));
      }
      OK('Manta', 'Log uploaded to ' + path);
      mclient.close();
      next(null, ctx);
  });
}

// Checks if the JIRA has been updated since you've last seen the preview
function isPreviewStale(ctx, next) {
  jira
    .findIssue(ID)
    .then(function(issue) {
      if (issue.fields.updated !== ctx.issue.updated) {
        WARN('JIRA', 'The notice preview is stale. Please re-run im-notices ' + 
          'for the latest data.');
        return next(new Error('JIRA has been updated!'));
      }
      next(null, ctx);
  }).catch(function(err) {
    console.error(err.message || err);
    next(new Error('Unable to retrieve JIRA: ' + ID));
  });
}

// Ensure JIRA has a correct Location and Type combination
function validateJIRA(ctx, next) {
  if (ctx.conf.SKIP_STATUS) {
    return next(null, ctx);
  }

  if (ctx.issue.issuetype.name === 'Security') {
    FAIL('Status.io', 'Manual notifications required for any ' +
      'security-related incident. Aborting.');
    return next(new Error('Security Type chosen on JIRA'), ctx);
  }

  request.get({
    url: process.env.STATUS_URL + 'component/list/' + ctx.conf.STATUS_PAGE_ID,
    json: true,
    headers: ctx.statusio.headers
  }, function (err, httpResponse, body) {
      // uncomment this to fetch the component IDs
      //console.log(JSON.stringify(body)); process.exit();
      if (err || body.status.error === 'yes') {
        WARN('Status.io', err || body);
        console.error('Continuing, but the JIRA\'s Location/Type could not be' +
          ' validated.');
        return next(null, ctx);
      }

      var component = ctx.conf.COMPONENT[ctx.issue.issuetype.name];
      var foundComponent;
      var i, j;

      // Check Component/Type
      for (i = 0; i < body.result.length; i++) {
        if (body.result[i]._id === component) {
          foundComponent = body.result[i];
          break;
        }
      }

      if (!foundComponent) {
        WARN('Status.io', 'Could not find the Component/Type: "' +
          ctx.issue.issuetype.name + '" on Status.io');
        console.error('Verify the Component ID on Status.io: %s', component);
        console.error(colors.bold('No notice will be posted on Status.io, you should' +
          ' correct the JIRA before proceeding.'));
        return next(null, ctx);
      }

      // Check Container/Locations
      // also save all the valid locations so we can inform the user if needed
      var components = [];

      if (ctx.details.location === 'None') {
          WARN('Status.io', 'The Location is currently set to "None" on ' +
            'the JIRA.');
          console.error(colors.bold('No notice will be posted on Status.io,' +
            ' you should consider adding a location to the JIRA.'));
          return next(null, ctx);
      }

      // Check the Locations on the JIRA with the valid Containers on Status.io
      if (ctx.issue[ctx.conf.LOCATION].length) {
        var locations = ctx.issue[ctx.conf.LOCATION].slice();
        for (i = 0; i < locations.length; i++) {
          for (j = 0; j < foundComponent.containers.length; j++) {
            components.push(foundComponent.containers[j].name);
            if (ctx.conf.CONTAINER[locations[i].value] === foundComponent.containers[j]._id) {
              locations[i].found = true;
              break;
            }
          }
        }

        var missingLocations = [];
        for (i = 0; i < locations.length; i++) {
          if (!locations[i].found) {
            missingLocations.push(locations[i].value);
          }
        }

        if (missingLocations.length) {
          WARN('Status.io', 'The following Locations are not valid for ' +
            '"' + ctx.issue.issuetype.name + '": ' +
            missingLocations.join(', '));
          console.error('\nValid locations for this type are: \n - ' +
            components.join('\n - '));
          console.error(colors.bold('No notice will be posted to Status.io, ' +
            'You should consider updating the JIRA before proceeding.'));
        }

      }
      next(null, ctx);
  });
}

module.exports = function () {
  vasync.waterfall([
    getJIRAByID,
    previewNotice,
    validateJIRA,
    confirmPreview,
    isPreviewStale,
    sendNotice,
    checkStatusNotice,
    sanityCheckStatusNotice,
    createStatusNotice,
    updateStatusNotice,
    updateJIRA,
    addCommentToJIRA,
    saveMantaLog
  ], function (error) {
    readline.close();
    if (error) {
      process.exitCode = 1;
      FAIL('Error', error);
    }
  });
};