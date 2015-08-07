module.exports = function(grunt) {
    // Load grunt plugins
    require('load-grunt-tasks')(grunt);

    grunt.initConfig({
        pkg: grunt.file.readJSON('package.json'),

        // Lint configuration
        jshint: {
          files: ['Gruntfile.js', 'index.js', 'test/index.js'],
          options: {
            jshintrc: '.jshintrc',
          }
        },

        // Test configuration
        mochaTest: {
            test: {
                src: ['test/**/*.js'],
            }
        },

        watch: {
            files: ['Gruntfile.js', 'index.js', 'test/index.js'],
            tasks: ['test']
        }
    });

    // rename the release task so we can use it in our custom task
    grunt.renameTask('release', 'publish');

    grunt.registerTask('release', function(target) {
        if (!target) { target = 'patch'; }
        grunt.task.run(['test', 'publish:'+target]);
    });

    grunt.registerTask('test', ['jshint', 'mochaTest']);
};
