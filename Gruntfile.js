module.exports = function(grunt) {
    // Load grunt plugins
    require('load-grunt-tasks')(grunt);

    grunt.initConfig({
        pkg: grunt.file.readJSON('package.json'),

        // Lint configuration
        jshint: {
            files: ['*.js', 'test/*.js'],
            // This is slower due to having to exclude all the extra files
            // files: ['**/*.js', '!**/node_modules/**'],
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
            files: ['*.js', 'test/*.js'],
            // This is slower due to having to exclude all the extra files
            // files: ['**/*.js', '!**/node_modules/**'],
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

    grunt.registerTask('default', ['watch']);
};
